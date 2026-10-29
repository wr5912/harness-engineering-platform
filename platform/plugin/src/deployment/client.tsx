import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'

type Target = { agent_id: string; experiment_id: string; label: string }
type Result = { ok: true; value: any } | { ok: false; error: { message: string } }
const stateLabels: Record<string, string> = { submitting: '正在确认导出请求', running: '正在生成安装包', completed: '安装包已生成', failed: '安装包生成失败', cancelled: '导出已取消', interrupted: '导出已中断' }
export function DeploymentDialog({ rpc, active, target, onClose }: Pick<PlatformPageProps, 'rpc'> & { active: boolean; target: Target; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0)
  const [arch, setArch] = useState('auto'), [mode, setMode] = useState('online')
  const [preview, setPreview] = useState<any>(null), [job, setJob] = useState<any>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [cancelling, setCancelling] = useState(false)
  const [submission, setSubmission] = useState<any>(null), [resourcesHelp, setResourcesHelp] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false), [knowledgeSources, setKnowledgeSources] = useState<Record<string, string>>({})
  const storageKey = `harness-deployment:${target.agent_id}:${target.experiment_id}`
  async function call(action: string, input: any) {
    const result = await rpc.call(CHANNEL, `agents/deployment/${action}`, input) as Result
    if (!result.ok) throw Object.assign(new Error(result.error.message), { confirmed: true })
    return result.value
  }
  useEffect(() => {
    generation.current++
    if (!active) { dialog.current?.close(); return }
    if (!dialog.current?.open) dialog.current?.showModal()
    setError(''); setPreview(null); setJob(null); setBusy(false); setCancelling(false); setSourcesOpen(false); setKnowledgeSources({}); setSubmission(null); setResourcesHelp(false)
    const token = generation.current
    let saved: string | null = null
    try { saved = sessionStorage.getItem(storageKey) } catch {}
    if (saved) {
      let record: any
      try { record = JSON.parse(saved) } catch { record = { id: saved } }
      if (typeof record.id === 'string') {
        setSubmission(record.input ?? null)
        setJob({ id: record.id, state: 'submitting', agent_id: target.agent_id, experiment_id: target.experiment_id })
        void call('status', { job_id: record.id }).then(value => { if (generation.current === token && value.agent_id === target.agent_id && value.experiment_id === target.experiment_id) { setJob(value); setArch(value.arch); setMode(value.mode) } })
          .catch(() => { if (generation.current === token) setError('导出状态暂时不可读，已保留本次请求。请等待恢复，或重新确认同一次导出。') })
      }
    }
    return () => { generation.current++ }
  }, [active, target.agent_id, target.experiment_id])
  useEffect(() => {
    if (!active || !['running', 'submitting'].includes(job?.state)) return
    const token = generation.current
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const value = await call('status', { job_id: job.id }); if (!disposed && generation.current === token) { setJob(value); setError(''); if (value.state === 'running') timer = setTimeout(poll, 1500) } }
      catch (error) { if (!disposed && generation.current === token) { setError(`状态暂时不可读，正在重试；请勿重复生成。${(error as Error).message}`); timer = setTimeout(poll, 3000) } }
    }
    timer = setTimeout(poll, 1000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, job?.id, job?.state])
  async function check() {
    const token = generation.current
    setBusy(true); setError(''); setPreview(null)
    try { const value = await call('preview', { agent_id: target.agent_id, experiment_id: target.experiment_id, ...(arch === 'auto' ? {} : { arch }), mode }); if (generation.current === token) { setPreview(value); if (arch === 'auto') setArch(value.arch) } }
    catch (error) { if (generation.current === token) setError((error as Error).message) }
    finally { if (generation.current === token) setBusy(false) }
  }
  async function submit(input: any) {
    const token = generation.current
    setBusy(true); setError(''); setCancelling(false); setSubmission(input)
    setJob({ id: input.request_id, state: 'submitting', ...target, arch: input.arch, mode: input.mode })
    try { sessionStorage.setItem(storageKey, JSON.stringify({ id: input.request_id, input })) } catch {}
    try {
      const value = await call('export', input)
      if (generation.current === token) setJob(value)
    } catch (error) {
      if (generation.current === token) {
        if ((error as any).confirmed) {
          setJob({ id: input.request_id, state: 'failed', error: (error as Error).message })
          try { sessionStorage.removeItem(storageKey) } catch {}
        } else setError('导出回执暂未收到，已保留本次请求；重新确认会使用同一身份，不重复生成。')
      }
    } finally { if (generation.current === token) setBusy(false) }
  }
  function start() {
    if (!preview || busy) return
    const id = crypto.getRandomValues(new Uint8Array(16))
    id[6] = (id[6] & 15) | 64; id[8] = (id[8] & 63) | 128
    const hex = [...id].map(value => value.toString(16).padStart(2, '0')).join('')
    const request_id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
    void submit({ request_id, agent_id: target.agent_id, experiment_id: target.experiment_id, arch, mode, expected_candidate_sha256: preview.candidateSha256,
      knowledge_sources: Object.entries(knowledgeSources).filter(([, path]) => path).map(([url, path]) => ({ url, path })) })
  }
  async function cancel() {
    const token = generation.current
    setCancelling(true)
    try { const value = await call('cancel', { job_id: job.id }); if (generation.current === token) setJob(value) }
    catch (error) { if (generation.current === token) { setError((error as Error).message); setCancelling(false) } }
  }
  const issues = preview?.issues ?? []
  const ready = preview && (preview.canPrepareResources || preview.resourceReady !== false && !issues.some((issue: any) => issue.severity !== 'warning'))
  const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`
  return <dialog ref={dialog} className="harness-asset-dialog agent-deployment-dialog" aria-labelledby="agent-deployment-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="agent-deployment-title">导出独立运行包</h2>
    <div className="agent-dialog-body">
      <p><strong>{target.label}</strong></p>
      <p className="agent-muted">打包当前版本已保存的资产，安装后使用原生 DSH 界面运行。默认携带现有模型、MCP 配置和凭据，可在目标环境重新配置。</p>
      {!job ? <>
        <div className="agent-deployment-grid">
          <label className="agent-field">目标架构<select value={arch} disabled={busy} onChange={event => { setArch(event.target.value); setPreview(null) }}><option value="auto">与当前平台相同</option><option value="amd64">AMD64 · x86_64</option><option value="arm64">ARM64 · aarch64</option></select></label>
          <label className="agent-field">部署网络<select value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setPreview(null) }}><option value="online">在线部署</option><option value="offline">离线部署</option></select></label>
        </div>
        <p className="agent-muted">{mode === 'offline' ? '保留本地知识，并归档可读取的必需静态参考。目标内网的模型和 MCP 服务仍需可达。' : '包含运行依赖和已有本地知识，允许使用外部模型、MCP 及在线参考。'}</p>
        {busy && <LoadingIndicator label="检查与准备安装包" />}
        {preview && <section aria-label="导出检查结果"><dl className="harness-fields"><div><dt>资产文件</dt><dd>{preview.files?.length ?? preview.fileCount ?? '已核对'}</dd></div><div><dt>运行资源</dt><dd>{preview.resourceReady ? '已准备' : preview.canPrepareResources ? '生成时自动准备' : '需要导入对应架构资源'}</dd></div></dl>
          {issues.length > 0 && <ul className="agent-deployment-issues">{issues.map((issue: any, index: number) => <li key={index}>{issue.message ?? String(issue)}</li>)}</ul>}
          {!preview.resourceReady && !preview.canPrepareResources && <>
            <button type="button" onClick={() => setResourcesHelp(!resourcesHelp)}>查看运行资源准备步骤</button>
            {resourcesHelp && <section aria-label="运行资源准备步骤"><p>在所选架构的在线准备机上，使用相同程序与数据版本运行：</p><pre className="harness-asset-content">{`./platform/dsh-deploy agent-prepare --agent-id ${target.agent_id} --source experiment:${target.experiment_id} --arch ${arch} --mode ${mode}`}</pre><p>将生成的 .local/deploy-assets/{arch}/ 复制到当前平台程序目录中的同名位置，再点击“检查安装包”。准备机需具备匹配的标准 DSH 镜像；缺少业务依赖时须先按该版本声明准备。</p><p className="agent-muted">也可通过 CLI 的 --image-archive 和 --docker-assets 导入对应架构镜像与 Docker 资源，不会混用本机架构。</p></section>}
          </>}
          {preview.notices?.map((notice: string) => <p key={notice} className="agent-muted">{notice}</p>)}
          {mode === 'offline' && preview.knowledge?.references?.some((ref: any) => ref.kind === 'document') && <>
            <button type="button" onClick={() => setSourcesOpen(!sourcesOpen)}>{sourcesOpen ? '收起本地资料选择' : '使用已有本地资料补充离线参考'}</button>
            {sourcesOpen && <section aria-label="补充离线资料"><p className="agent-muted">可为参考链接选择当前版本中的文档；其余资料在生成时尝试下载。新资料请先通过知识整理或资产入口保存到当前版本，再重新检查。</p>
              {[...new Set<string>(preview.knowledge.references.filter((ref: any) => ref.kind === 'document').map((ref: any) => ref.url))].map(url => <label key={url} className="agent-field"><span className="agent-deployment-url" title={url}>{url}</span><select value={knowledgeSources[url] ?? ''} onChange={event => setKnowledgeSources(previous => ({ ...previous, [url]: event.target.value }))}><option value="">自动取得参考资料</option>{preview.files.filter((file: any) => /\.(?:md|markdown|txt|html?|pdf|docx)$/i.test(file.path)).map((file: any) => <option key={file.path} value={file.path.replace(/^assets\//, 'dsh/')}>{file.path.replace(/^assets\//, '')}</option>)}</select></label>)}
            </section>}
          </>}
          {ready && <p role="status">可以生成安装包。包内包含连接凭据，请妥善保管。</p>}
        </section>}
      </> : <section aria-label="导出任务状态"><h3>{stateLabels[job.state] ?? '导出状态待核对'}</h3>
        {['running', 'submitting'].includes(job.state) && <><LoadingIndicator label="生成安装包" /><p role="status">{typeof job.progress === 'string' ? job.progress : job.progress?.message ?? '正在收集资产、运行依赖和镜像。关闭窗口后任务继续执行。'}</p></>}
        {job.error && <p role="alert">{job.error}</p>}
        {job.state === 'completed' && <><p>安装包大小：{bytes(job.size ?? 0)}。解包后运行 install.sh；缺少 Docker 时按目标环境自动离线安装。</p><p className="agent-muted">包内包含连接凭据，请妥善保管。业务效果仍需在目标环境核验。</p><a className="agent-primary agent-deployment-download" href={new URL(job.download ?? `api/harness-platform/agent-deployments/download?job_id=${job.id}`, window.location.href).href}>下载安装包</a></>}
      </section>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="agent-actions agent-dialog-actions">
      {!job && <><button type="button" disabled={busy} onClick={() => void check()}>检查安装包</button><button type="button" className="agent-primary" disabled={busy || !ready} onClick={() => void start()}>{preview?.canPrepareResources && !preview.resourceReady ? '准备并生成安装包' : '生成安装包'}</button></>}
      {job?.state === 'running' && <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消导出'}</button>}
      {job?.state === 'submitting' && submission && <button type="button" disabled={busy} onClick={() => void submit(submission)}>重新确认本次导出</button>}
      {job && !['running', 'submitting'].includes(job.state) && <button type="button" onClick={() => { setJob(null); setPreview(null); setError(''); setCancelling(false); setSubmission(null); try { sessionStorage.removeItem(storageKey) } catch {} }}>重新检查</button>}
      <button type="button" onClick={onClose}>关闭</button>
    </div>
  </dialog>
}
