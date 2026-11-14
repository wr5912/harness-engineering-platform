import { useCallback, useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { SdkDebugDialog } from './sdk-client.tsx'
import { DeploymentDialog } from '../deployment/client.tsx'
import { AgentDescriptionPanel } from './description-client.tsx'
import { AgentEvaluationOverview, type AgentRunOverview } from './overview.tsx'
import { instanceWebUrl } from '../instances/url.ts'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import type { PlatformUpdates } from '../realtime/client.ts'

type Agent = { id: string; name: string; notes: string | null; source_id: string; repository: string; path: string;
  branch: string | null; commit: string | null; asset_commit: string | null; dirty: boolean; digest: string; profile: string; files: string[]; tag: string | null;
  versions: { tag: string; source_id: string; commit: string }[] }
type Asset = { path: string; kind: string; content?: string; sha256?: string; editable?: boolean; size?: number; reason?: string }
type Node = { name: string; path: string; children: Node[] }
const tabs = [{ id: 'overview', label: '概览' }, { id: 'description', label: '描述与技能' }, { id: 'assets', label: 'Harness 资产' }] as const
type Tab = typeof tabs[number]['id']
function tree(files: string[]): Node[] {
  const roots: Node[] = []
  for (const file of files) {
    let children = roots, path = ''
    for (const name of file.split('/')) {
      path = path ? `${path}/${name}` : name
      let node = children.find(item => item.path === path)
      if (!node) { node = { name, path, children: [] }; children.push(node) }
      children = node.children
    }
  }
  return roots
}
function AssetTree({ nodes, selected, onSelect }: { nodes: Node[]; selected: string; onSelect(path: string): void }) {
  return <ul className="harness-asset-tree">{nodes.map(node => <li key={node.path}>{node.children.length
    ? <details open={selected.startsWith(node.path + '/')}><summary>{node.name}/</summary><AssetTree nodes={node.children} selected={selected} onSelect={onSelect}/></details>
    : <button type="button" aria-pressed={selected === node.path} onClick={() => onSelect(node.path)}>{node.name}</button>}</li>)}</ul>
}
function Fields({ items }: { items: [string, unknown][] }) {
  return <dl className="harness-fields">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value == null || value === '' ? '未记录' : String(value)}</dd></div>)}</dl>
}
export function BusinessAgentsPage({ rpc, target, onNavigate, onContext, onAssistant, updates, active = true }: PlatformPageProps & {
  target?: PlatformNavigation; onNavigate?(value: PlatformNavigation): void; updates?: PlatformUpdates;
  onContext?(value: Record<string, unknown>): void; onAssistant?(task: string, context: Record<string, unknown>): Promise<void>; active?: boolean
}) {
  const [agents, setAgents] = useState<Agent[]>([]), [selected, setSelected] = useState(target?.agent_id ?? '')
  const [search, setSearch] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [file, setFile] = useState('harness.yaml'), [asset, setAsset] = useState<Asset | null>(null)
  const [reading, setReading] = useState(false), [revision, setRevision] = useState(0)
  const [sdkTab, setSdkTab] = useState<'debug' | 'guide' | null>(null), [tab, setTab] = useState<Tab>('overview')
  const [mobileList, setMobileList] = useState(false), [more, setMore] = useState(false)
  const [version, setVersion] = useState(target?.source_id?.includes('@') ? target.source_id : ''), [versionDetail, setVersionDetail] = useState<Agent | null>(null)
  const [deployment, setDeployment] = useState<{ agent_id: string; experiment_id: string; label: string } | null>(null)
  const [overview, setOverview] = useState<AgentRunOverview | null>(null)
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [saving, setSaving] = useState(false), [message, setMessage] = useState('')
  const request = useRef(0), dirtyDescription = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const current = agents.find(value => value.id === selected), agent = version ? versionDetail : current
  const call = useCallback(async (method: string, payload: Record<string, unknown> = {}) => {
    const result = await rpc.call(CHANNEL, method, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as any
  }, [rpc])
  const refresh = () => setRevision(value => value + 1)
  const refreshChanged = useQueuedRefresh(active, async () => { refresh() })
  useEffect(() => updates?.subscribe(() => {
    if (updates.getSnapshot().domains.some(domain => ['agents', 'instances', 'catalog'].includes(domain))) void refreshChanged()
  }), [updates])
  const descriptionDirty = useCallback((value: boolean) => { dirtyDescription.current = value }, [])
  const canLeave = () => !saving && (!(editing && draft !== asset?.content || dirtyDescription.current) || window.confirm('当前有未保存修改，确认放弃草稿？'))
  const context = (value: Agent) => ({ page: 'agents', agent_id: value.id, source_id: value.source_id, source_root: value.path, tab })
  const navigate = (page: 'instances' | 'evaluation', targetTab?: string, runId?: string) => {
    if (agent) onNavigate?.({ page, agent_id: agent.id, source_id: agent.source_id, ...(page === 'evaluation' ? { experiment_id: agent.source_id } : {}), ...(targetTab ? { tab: targetTab } : {}), ...(runId ? { run_id: runId } : {}) })
  }
  useEffect(() => {
    if (!active) return
    const sequence = ++request.current
    setLoading(true); setError('')
    void call('agents/business/list').then(value => {
      if (request.current !== sequence) return
      setAgents(value.agents)
      setSelected(current => value.agents.some((item: Agent) => item.id === current) ? current : value.agents[0]?.id ?? '')
      setError(Object.entries(value.errors).map(([id, reason]) => `${id}：${reason}`).join('；'))
    }).catch(reason => { if (request.current === sequence) setError(reason.message) })
      .finally(() => { if (request.current === sequence) setLoading(false) })
    return () => { request.current++ }
  }, [active, call, revision])
  useEffect(() => {
    setVersionDetail(null)
    if (!active || !version || !current) return
    let disposed = false
    void call('agents/business/detail', { agent_id: current.id, source: version }).then(value => { if (!disposed) setVersionDetail(value) })
      .catch(reason => { if (!disposed) setError(reason.message) })
    return () => { disposed = true }
  }, [active, call, version, current?.id, current?.digest, revision])
  useEffect(() => {
    if (!target?.agent_id) return
    setSelected(target.agent_id); setVersion(target.source_id?.includes('@') ? target.source_id : '')
    setFile(target.asset_path?.replace(`agents/${target.agent_id}/`, '') ?? 'harness.yaml')
    if (tabs.some(value => value.id === target.tab)) setTab(target.tab as Tab)
  }, [target?.agent_id, target?.source_id, target?.asset_path, target?.tab])
  useEffect(() => { if (active && agent) onContext?.(context(agent)) }, [active, agent?.id, agent?.source_id, agent?.digest, tab, onContext])
  useEffect(() => {
    if (!active || !agent || tab !== 'assets') return
    let disposed = false
    setAsset(null); setReading(true); setMessage('')
    void call('agents/edit/read', { experiment_id: agent.source_id, path: file }).then(value => { if (!disposed) setAsset(value) })
      .catch(reason => { if (!disposed) setError(reason.message) }).finally(() => { if (!disposed) setReading(false) })
    return () => { disposed = true }
  }, [active, agent?.source_id, agent?.digest, file, tab, call, revision])
  useEffect(() => {
    if (!active || !agent || tab !== 'overview') return
    let disposed = false
    const identity = { agentId: agent.id, experimentId: agent.source_id }
    setOverview({ ...identity, phase: 'loading', runs: [] })
    void call('agents/runs/index', { agent_id: agent.id }).then(async value => {
      const runs = (value.experiments ?? []).flatMap((entry: any) => entry.runs ?? []).filter((run: any) => run.source_id === agent.source_id).sort((a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      if (disposed) return
      setOverview({ ...identity, phase: 'ready', runs, latest: runs[0] })
      if (runs[0]) try {
        const detail = await call('agents/runs/show', { run_id: runs[0].run_id })
        if (!disposed) setOverview({ ...identity, phase: 'ready', runs, latest: runs[0], detail })
      } catch (reason) { if (!disposed) setOverview({ ...identity, phase: 'ready', runs, latest: runs[0], detailError: (reason as Error).message }) }
      if (value.errors?.length && !disposed) setOverview(previous => previous && ({ ...previous, refreshError: '部分评测记录读取失败，请到评测中心核对' }))
    }).catch(reason => { if (!disposed) setOverview({ ...identity, phase: 'error', runs: [], error: reason.message }) })
    return () => { disposed = true }
  }, [active, agent?.source_id, agent?.digest, tab, call, revision])
  useEffect(() => {
    if (editing && active && !dialog.current?.open) dialog.current?.showModal()
    else if ((!editing || !active) && dialog.current?.open) dialog.current.close()
  }, [editing, active])
  function select(id: string, source = '') {
    if (!canLeave()) return
    setSelected(id); setVersion(source); setVersionDetail(null); setFile('harness.yaml'); setError(''); setEditing(false); setMore(false); setMobileList(false); dirtyDescription.current = false
    onNavigate?.({ page: 'agents', agent_id: id, source_id: source || `business:${id}`, tab })
  }
  function selectTab(value: Tab) {
    if (!canLeave()) return
    setTab(value); setEditing(false)
    onNavigate?.({ page: 'agents', agent_id: selected, source_id: agent?.source_id, tab: value })
  }
  async function save() {
    if (!agent || !asset || saving) return
    setSaving(true); setMessage('')
    try { await call('agents/edit/apply', { experiment_id: agent.source_id, edits: [{ path: asset.path, content: draft, expected_sha256: asset.sha256 }] }); setEditing(false); setMessage('已保存到业务仓。'); refresh() }
    catch (reason) { setMessage((reason as Error).message + '；草稿已保留。') }
    finally { setSaving(false) }
  }
  async function enterConversation() {
    if (!agent) return
    setError('')
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    try {
      const value = await call('instances/list')
      const instances = (value.instances ?? []).filter((item: any) => item.source_id === agent.source_id && item.state === 'running')
      if (instances.length !== 1) { popup?.close(); navigate('instances'); return }
      const url = await call('instances/url', { name: instances[0].name })
      const destination = instanceWebUrl(url, window.location.hostname)
      if (popup) popup.location.href = destination
      else window.location.assign(destination)
    } catch (reason) { popup?.close(); setError((reason as Error).message) }
  }
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (editing && draft !== asset?.content || dirtyDescription.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [editing, draft, asset?.content])
  const descriptionDetail = agent && { source_id: agent.source_id, experiment: { id: agent.source_id }, candidate_sha256: agent.digest,
    editable_files: agent.files.map(path => `agents/${agent.id}/${path}`) }
  const visible = agents.filter(value => `${value.name} ${value.id}`.toLowerCase().includes(search.toLowerCase()))
  return <main className="harness-agents" data-active-tab={tab} aria-label="智能体管理"><div className="agent-page-content">
    <header className="agent-page-heading"><div className="agent-page-intro"><span className="agent-page-kicker">构建与演进</span><h1>智能体管理</h1><p>管理业务智能体的 Harness、技能与评测，版本来自 business-agents 的 Git tag。</p></div>
      <div className="agent-actions"><button type="button" className="agent-primary" disabled={!onAssistant} onClick={() => void onAssistant?.('在 business-agents 中创建业务智能体，按原生 DSH Harness 文件结构维护，并更新仓库索引。先了解业务目标。', { page: 'agents', skill: 'agent-maintenance' })}>新建智能体</button><button type="button" disabled={!onAssistant} onClick={() => void onAssistant?.('将已有业务智能体导入 business-agents，保留 DSH 原生 Harness 结构，核对仓库索引和可装载性。', { page: 'agents', skill: 'agent-maintenance' })}>导入 / 迁移</button><button type="button" disabled={loading} onClick={refresh}>刷新</button></div></header>
    {error && <p role="alert" className="agent-error">{error}</p>}
    <section className="harness-agent-layout" data-active-tab={tab} data-mobile-list={mobileList || !selected}>
      <aside className="harness-agent-list"><div className="agent-list-heading"><h2>智能体列表</h2><span>{agents.length}</span></div><label className="agent-search"><span>搜索智能体</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称或 ID"/></label>
        {loading && <LoadingIndicator label="读取业务仓智能体" block/>}<div className="harness-agent-list-options">{visible.map(value => <div className="agent-list-entry" key={value.id}><button id={`agent-list-card-${value.id}`} type="button" className="agent-list-card" aria-pressed={selected === value.id} onClick={() => select(value.id)}><span className="agent-list-card-title"><strong>{value.name}</strong><span className="agent-badge">{value.profile === 'sdk' ? 'SDK' : 'DSH'}</span></span><span className="agent-id">{value.id}</span><span className="agent-list-description">{value.notes || '未填写备注'}</span><span className="agent-list-meta">{value.versions.length} 个 Git tag · {value.dirty ? '有本地修改' : '已提交'}</span></button></div>)}</div>{!loading && !visible.length && <p className="agent-empty">{agents.length ? '没有匹配的智能体。' : '业务仓中没有 active 智能体。'}</p>}</aside>
      <section className="harness-agent-detail" data-active-tab={tab}>
        {version && !agent && !error && <LoadingIndicator label="读取 Git tag 资产" block/>}
        {agent && <><section className="agent-identity" id="agent-identity" tabIndex={-1}><button type="button" className="agent-back-to-list" onClick={() => setMobileList(true)}>← 返回智能体列表</button><div className="agent-identity-top"><div className="agent-identity-title"><span className="agent-identity-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25 16 9.8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg></span><h2>{agent.name}</h2><SearchSelect className="agent-version-choice" label="版本（Git tag）" value={version} options={(current?.versions ?? []).map(item => ({ value: item.source_id, label: item.tag, description: item.commit.slice(0, 12) }))} placeholder={current?.versions.length ? '选择 Git tag' : '暂无 Git tag'} disabled={!current?.versions.length} onChange={value => select(selected, value)}/><span className="agent-badge">{agent.tag ? 'Git tag' : '当前工作树'}</span></div>
          <div className="agent-actions agent-main-actions">{agent.profile === 'sdk' ? <><button type="button" className="agent-primary" onClick={() => setSdkTab('debug')}>SDK 调试</button><button type="button" onClick={() => setSdkTab('guide')}>接入文档</button></> : <><button type="button" className="agent-primary" disabled={!onNavigate} onClick={() => navigate('evaluation', 'cases')}>发起评测</button><button type="button" onClick={() => void enterConversation()}>进入对话</button></>}<details className="agent-more-actions" open={more}><summary onClick={event => { event.preventDefault(); setMore(!more) }}>更多操作</summary><div><button type="button" disabled={!onNavigate} onClick={() => navigate('instances')}>创建 / 查看实例</button><button type="button" disabled={!onNavigate} onClick={() => navigate('evaluation', 'runs')}>查看评测</button><button type="button" onClick={() => { if (canLeave()) { setMore(false); setDeployment({ agent_id: agent.id, experiment_id: agent.source_id, label: agent.name }) } }}>导出独立运行包</button>{version && <button type="button" onClick={() => select(selected)}>查看当前工作树</button>}</div></details></div></div><p className="agent-muted">{agent.tag ? `Git tag：${agent.tag}` : `当前工作树 · ${agent.branch || '分支未记录'}`}{!current?.versions.length && ' · 业务仓尚未创建 Git tag'}</p></section>
          <div role="tablist" aria-label="智能体详情" className="harness-agent-tabs" onKeyDown={event => { const at = tabs.findIndex(item => item.id === tab); const next = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined; if (next === undefined) return; event.preventDefault(); selectTab(tabs[next].id); document.getElementById(`agent-tab-${tabs[next].id}`)?.focus() }}>{tabs.map(item => <button key={item.id} type="button" role="tab" id={`agent-tab-${item.id}`} aria-controls={`agent-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)}>{item.label}</button>)}</div>
          <section role="tabpanel" id="agent-panel-overview" aria-labelledby="agent-tab-overview" hidden={tab !== 'overview'}><div className="agent-section-heading"><h2>用途与特性</h2><button type="button" disabled={!onAssistant} onClick={() => void onAssistant?.('核对当前业务 Harness 的用途与技能；需要完善说明时直接维护业务仓的原生 Preset 和 Skill。', context(agent))}>请 AI 整理特性</button></div><p>{agent.notes || '请在描述与技能中完善业务用途。'}</p><AgentEvaluationOverview value={overview} versionLabel={agent.tag || '当前工作树'} onOpenRun={onNavigate ? id => navigate('evaluation', 'runs', id) : undefined} onOpenEvaluation={onNavigate ? () => navigate('evaluation', 'runs') : undefined}/><h3>资产来源</h3><Fields items={[["Agent ID", agent.id], ["资产目录", agent.path], ["仓库提交", agent.commit], ["资产提交", agent.asset_commit], ["资产摘要", agent.digest], ["工作树", agent.tag ? '只读 Git tag' : agent.dirty ? '有本地修改' : '已提交']]}/></section>
          <section role="tabpanel" id="agent-panel-description" aria-labelledby="agent-tab-description" hidden={tab !== 'description'}>{tab === 'description' && <AgentDescriptionPanel key={agent.source_id} active={active} rpc={rpc} detail={descriptionDetail} agentId={agent.id} onSaved={refresh} onEditAsset={path => { setFile(path.replace(`agents/${agent.id}/`, '')); setTab('assets') }} onDirtyChange={descriptionDirty} onAssistant={onAssistant}/>}</section>
          <section role="tabpanel" id="agent-panel-assets" aria-labelledby="agent-tab-assets" hidden={tab !== 'assets'}><div className="agent-section-heading"><h2>智能体资产</h2><button type="button" disabled={!onAssistant} onClick={() => void onAssistant?.('审视当前业务 Harness 的原生配置、技能和 MCP 连接，依据真实文件及执行证据给出改进建议。', context(agent))}>请 AI 助手评价</button></div><div className="harness-asset-layout"><nav aria-label="智能体资产目录"><AssetTree nodes={tree(agent.files)} selected={file} onSelect={path => { if (canLeave()) { setFile(path); setEditing(false) } }}/></nav><article><h3>资产详情</h3><p>{file}</p>{reading ? <LoadingIndicator label="读取资产" block/> : asset && <><Fields items={[["类型", asset.kind === 'text' ? '文本' : asset.kind === 'directory' ? '目录' : '二进制或大文件'], ["大小（字节）", asset.size], ["SHA-256", asset.sha256]]}/>{asset.kind === 'text' && <><button type="button" disabled={!asset.editable} onClick={() => { setDraft(asset.content ?? ''); setEditing(true) }}>编辑</button>{asset.reason && <p role="status">{asset.reason}</p>}<pre className="harness-asset-content">{asset.content || '空文件'}</pre></>}</>}{message && <p role="status">{message}</p>}</article></div><DetailDrawer title="来源与 Runtime 配置" active={active && tab === 'assets'} identity={agent.source_id}><Fields items={[["业务仓", agent.repository], ["来源", agent.source_id], ["Profile", agent.profile], ["Harness", agent.path]]}/></DetailDrawer></section>
        </>}
      </section></section>
    <dialog ref={dialog} className="harness-asset-dialog" aria-labelledby="asset-edit-title" onCancel={event => { event.preventDefault(); if (canLeave()) setEditing(false) }}><h2 id="asset-edit-title">编辑资产</h2><p>{asset?.path}</p><label className="agent-field">文件内容<textarea className="agent-editor" value={draft} rows={18} disabled={saving} onChange={event => setDraft(event.target.value)}/></label>{message && <p role="status">{message}</p>}<footer className="agent-actions agent-dialog-actions"><button type="button" className="agent-primary" disabled={saving || draft === asset?.content} onClick={() => void save()}>{saving ? '正在保存…' : '保存修改'}</button><button type="button" disabled={saving} onClick={() => { if (canLeave()) setEditing(false) }}>取消</button></footer></dialog>
    {deployment && <DeploymentDialog key={deployment.experiment_id} rpc={rpc} active={active} target={deployment} onClose={() => setDeployment(null)}/>}
    {agent && sdkTab && <SdkDebugDialog rpc={rpc} active={active} source={agent.source_id} agentId={agent.id} label={agent.name} initialTab={sdkTab} onClose={() => setSdkTab(null)}/>}</div>
  </main>
}
