import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import { navigationHash } from '../navigation.ts'
import type { ComputeMetric, ComputePlan } from './compute-variants.ts'
import { ComputePlanningDialog, catalogChoices, type ComputePlanningRequest } from './compute-planning-dialog.tsx'

type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
type ComputeRun = { run_id: string; experiment_id: string; status: string; created_at: string; title?: string; effective_verdict?: 'passed' | 'failed' | 'inconclusive' | null }
type RegisteredTrainingServer = { id: string; name: string; host: string; port: number; user: string; workDir: string; auth: 'ssh_key' | 'password'; credentialRef: string }
type Context = {
  experiment_id: string; agent_id: string; parent_ref: string; parent_experiment_id: string | null; fixed_parent_ref: string | null
  plan: ComputePlan | null; variant_name?: string | null; variant_kind: string; decision: string
  cases: { case_id: string; title: string }[]
  runs: ComputeRun[]
  candidate_sha256?: string
  generation?: { mode: string; entry_path: string; source_run_ids: string[] } | null
  build?: { verified: boolean; error?: string } | null
  comparison?: any
  workflow_status?: { generated: boolean; built: boolean; frozen: boolean; loaded: boolean; compared: boolean }
}
const labels: Record<ComputeMetric | 'actual_model_calls', string> = { actual_model_calls: '实际模型请求次数（含重试）', model_calls: '已记录模型响应次数', input_tokens: '输入 token（含缓存）', output_tokens: '输出 token', total_tokens: '总 token', elapsed_ms: '主 Session 耗时（毫秒）' }
const display = (value: number | null | undefined) => value === null || value === undefined ? '未知' : Number.isInteger(value) ? String(value) : value.toFixed(2)
const percentage = (value: number | null | undefined) => value === null || value === undefined ? '未知' : `${display(value)}%`
const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id]
const runStatus = (status: string) => ({ completed: '执行完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[status] ?? '状态未知'
const runOutcome = (run: ComputeRun) => run.status === 'completed'
  ? ({ passed: '成功', failed: '未通过', inconclusive: '无法判定' } as Record<string, string>)[run.effective_verdict ?? ''] ?? '结果待核对'
  : run.status === 'failed' ? '异常' : runStatus(run.status)
function notSent(message: string) {
  return Object.assign(new Error(message), { definitelyNotSent: true })
}
function ComputeIcon({ kind }: { kind: 'sparkle' | 'run' | 'info' }) {
  const paths = {
    sparkle: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /><path d="m19 2 .7 2.3L22 5l-2.3.7L19 8l-.7-2.3L16 5l2.3-.7Z" /></>,
    run: <><path d="m9 5 10 7-10 7Z" /><path d="M4 4v16" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  }
  return <svg className="compute-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}

export function ComputeVariantsPanel({ rpc, agentId, agentName, experimentId, versionLabel, currentVariantName, versions, onCreated, onChanged, onAssistant, themeScheme, onThemeToggle }: PlatformPageProps & {
  agentId: string; experimentId: string; versions: Array<{ id: string }>; onCreated?: (experimentId: string) => void; onChanged?: () => void
  agentName?: string; versionLabel?: string
  currentVariantName?: string | null
  onAssistant?(task: string, context: Record<string, unknown>): Promise<void>
  themeScheme?: 'light' | 'dark'
  onThemeToggle?(): void
}) {
  const generation = useRef(0)
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [manualPreview, setManualPreview] = useState<{ input: Record<string, unknown>; value: any } | null>(null)
  const [createOpen, setCreateOpen] = useState(false), [parent, setParent] = useState(experimentId), [parentRef, setParentRef] = useState('')
  const [variantName, setVariantName] = useState(''), [strategy, setStrategy] = useState(''), [selectedCases, setSelectedCases] = useState<string[]>([]), [critical, setCritical] = useState<string[]>([])
  const [minimum, setMinimum] = useState(2), [drop, setDrop] = useState(0), [metric, setMetric] = useState<ComputeMetric>('total_tokens'), [reduction, setReduction] = useState(10)
  const [modelChange, setModelChange] = useState(false), [model, setModel] = useState('deepseek-flash'), [reasoning, setReasoning] = useState('off')
  const [codeMode, setCodeMode] = useState(false), [sourceRuns, setSourceRuns] = useState<string[]>([])
  const [generatedCode, setGeneratedCode] = useState<any>(null), [freezePreview, setFreezePreview] = useState<any>(null)
  const [parentRuns, setParentRuns] = useState<string[]>([]), [variantRuns, setVariantRuns] = useState<string[]>([])
  const [comparison, setComparison] = useState<any>(null), [humanConfirmed, setHumanConfirmed] = useState(false), [reason, setReason] = useState('')
  const [planningOpen, setPlanningOpen] = useState(false), [planningDirty, setPlanningDirty] = useState(false)
  const selectedVariantName = currentVariantName === undefined ? context?.variant_name : currentVariantName
  const displayVersion = versionLabel || experimentId
  const displayAgent = agentName || agentId
  const selectedRuns = context?.runs.filter(run => run.experiment_id === experimentId).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))) ?? []
  const latestRun = selectedRuns[0]
  const targetReduction = context?.plan ? comparison?.resources?.[context.plan.resource_metric]?.reduction_pct : null
  const resourceOutcome = comparison?.resource_evidence?.passed ? '满足预定目标'
    : comparison?.resource_evidence?.limits?.length || targetReduction === null || targetReduction === undefined ? '证据不足' : '未满足预定目标'
  async function invoke(method: string, body: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, `agents/compute-variants/${method}`, body) as Result
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  function restoreContext(value: Context) {
    setContext(value); setComparison(value.comparison ?? null); setHumanConfirmed(false)
    setParentRuns(value.comparison?.parent_run_ids ?? []); setVariantRuns(value.comparison?.variant_run_ids ?? [])
  }
  useEffect(() => {
    const request = ++generation.current
    setBusy(true); setContext(null); setComparison(null); setParentRuns([]); setVariantRuns([]); setParent(experimentId); setVariantName(''); setStrategy(''); setSelectedCases([]); setCritical([]); setMinimum(2); setDrop(0); setMetric('total_tokens'); setReduction(10); setModelChange(false); setModel('deepseek-flash'); setReasoning('off'); setReason(''); setError(''); setMessage(''); setCreateOpen(false); setPlanningOpen(false); setPlanningDirty(false); setManualPreview(null); setHumanConfirmed(false); setGeneratedCode(null); setFreezePreview(null); setSourceRuns([]); setCodeMode(false)
    invoke('context', { experiment_id: experimentId }).then(value => {
      if (request !== generation.current) return
      restoreContext(value); setParentRef(value.parent_ref); setSelectedCases(value.cases.map((item: any) => item.case_id)); setCritical([])
    }).catch(error => { if (request === generation.current) setError(error.message) })
      .finally(() => { if (request === generation.current) setBusy(false) })
    return () => { generation.current++ }
  }, [rpc, experimentId])
  async function action(task: () => Promise<void>) {
    const request = generation.current
    setBusy(true); setError(''); setMessage('')
    try { await task() } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : '算力变体操作失败') }
    finally { if (request === generation.current) setBusy(false) }
  }
  function changeRuns(side: 'parent' | 'variant', id: string) {
    if (side === 'parent') setParentRuns(values => toggle(values, id)); else setVariantRuns(values => toggle(values, id))
    setComparison(null); setHumanConfirmed(false)
  }
  async function sendPlanning(request: ComputePlanningRequest) {
    if (!context || !onAssistant) throw notSent('平台 AI 助手暂不可用，请稍后重试。')
    const requestGeneration = generation.current
    const allowedRuns = new Set(context.runs.filter(run => run.experiment_id === experimentId).map(run => run.run_id))
    const sourceRunIds = request.tracePlanRequested ? [] : request.sourceRunIds.filter(id => allowedRuns.has(id))
    if (!request.tracePlanRequested && (!sourceRunIds.length || sourceRunIds.length !== request.sourceRunIds.length)) throw notSent('来源轨迹已变化，请刷新并重新选择当前版本的 Run。')
    if (request.type === 'medium' && request.medium?.serverMode === 'new' && request.medium.credentialRef && !/^ref:[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(request.medium.credentialRef)) throw notSent('训练凭据只接受 ref: 开头的引用标识，不发送密码或私钥原文。')
    if (request.type === 'medium' && request.medium?.baseModelMode === 'catalog') {
      let models: Result
      try { models = await rpc.call(CHANNEL, 'models/list', {}) as Result }
      catch { throw notSent('无法核对当前智能体可用的基模型，请稍后重试。') }
      if (requestGeneration !== generation.current) throw notSent('工作对象已变化，请重新打开策划弹窗。')
      if (!models.ok) throw notSent('无法核对当前智能体可用的基模型，请稍后重试。')
      let selected = false
      try { selected = catalogChoices(models.value).some(item => `${item.provider}/${item.model}` === request.medium!.baseModelId) }
      catch { throw notSent('无法核对当前智能体可用的基模型，请稍后重试。') }
      if (!selected) throw notSent('所选基模型已不在当前业务可用目录中，请刷新模型目录并重新选择。')
    }
    let registeredServer: RegisteredTrainingServer | undefined
    if (request.type === 'medium' && request.medium?.serverMode === 'registered') {
      let listed: Result
      try { listed = await rpc.call(CHANNEL, 'agents/training-servers/list', {}) as Result }
      catch { throw notSent('无法核对已登记训练连接，请稍后重试。') }
      if (requestGeneration !== generation.current) throw notSent('工作对象已变化，请重新打开策划弹窗。')
      if (!listed.ok || !Array.isArray(listed.value?.servers)) throw notSent('无法核对已登记训练连接，请稍后重试。')
      registeredServer = (listed.value.servers as RegisteredTrainingServer[]).find(server => server.id === request.medium!.serverId)
      const fields = ['host', 'port', 'user', 'workDir', 'auth', 'credentialRef'] as const
      if (!registeredServer || fields.some(field => registeredServer![field] !== request.medium![field])) throw notSent('已登记训练连接发生变化，请刷新连接列表并重新选择。')
    }
    const typeLabel = request.type === 'medium' ? '中算力' : '低算力'
    const variantName = request.variantName.trim() || `${displayAgent} · ${typeLabel}变体`
    const route = request.type === 'medium'
      ? '从轨迹抽取决策样本，评估基模型并训练决策模型，再用 LangGraph 将决策模型与现有真实工具编排成近似等效变体。'
      : '从轨迹提取稳定规则和分支，用 LangGraph 代码与现有真实工具模拟原执行路径，不训练决策模型。'
    const training = request.medium?.serverMode === 'registered' ? registeredServer : request.medium
    const medium = request.type === 'medium' && request.medium ? {
      base_model_mode: request.medium.baseModelMode,
      base_model_id: request.medium.baseModelMode === 'suggest' ? null : request.medium.baseModelId || null,
      base_model_revision: request.medium.revision || null,
      training_server_mode: request.medium.serverMode,
      server_id: request.medium.serverMode === 'registered' ? request.medium.serverId || null : null,
      server_name: registeredServer?.name || null,
      server_host: request.medium.serverMode !== 'later' ? training?.host || null : null,
      server_port: request.medium.serverMode !== 'later' ? training?.port || null : null,
      ssh_user: request.medium.serverMode !== 'later' ? training?.user || null : null,
      work_dir: request.medium.serverMode !== 'later' ? training?.workDir || null : null,
      ssh_auth_method: request.medium.serverMode !== 'later' ? training?.auth || null : null,
      credential_ref: request.medium.serverMode !== 'later' && training?.credentialRef.startsWith('ref:') ? training.credentialRef : null,
    } : null
    const low = request.type === 'low' && request.low ? { uncovered_policy: request.low.uncovered, requirements: request.low.requirements.trim() } : null
    const traceSummary = request.tracePlanRequested ? '待策划采集范围' : sourceRunIds.map(id => {
      const run = context.runs.find(item => item.run_id === id)
      return run?.title ? `${run.title}（Run …${id.slice(-8)}；${runOutcome(run)}）` : `Run ${id}（${run ? runOutcome(run) : '结果待核对'}）`
    }).join('；')
    const task = [
      `## ${typeLabel}变体策划请求`,
      `- 对象：${displayAgent} · ${displayVersion}（${experimentId}）`,
      `- 变体：${variantName}`,
      `- 目标：${request.goal.trim().replace(/\s+/g, ' ')}`,
      `- 路线：${request.type === 'medium' ? '决策样本 → 决策模型训练 → LangGraph 与真实工具编排' : '轨迹规则与分支 → LangGraph 代码 → 复用真实工具'}`,
      `- 来源轨迹：${traceSummary}`,
      `- 工具与未覆盖：${request.type === 'medium' ? '复用现有真实工具；训练条件与未覆盖场景待核对' : `复用现有真实工具；未覆盖时${low?.uncovered_policy === 'request_human' ? '暂停并请求人工处理' : '中止并报告'}`}`,
      '- 待验证：场景覆盖、关键行为、独立比较和实际资源收益；近似等效尚未确认。',
      '',
      `请使用 compute-variant-research，为 ${displayAgent} 的 ${displayVersion}（${experimentId}）策划${typeLabel}变体“${variantName}”。本次只策划，不连接服务器、启动训练、生成或创建变体。`,
      `策划请求编号：${request.requestId}。如果发送结果未知，先按此编号核对已有会话，不自动重发。`,
      `技术路线：${route}`,
      `目标：${request.goal.trim()}`,
      request.tracePlanRequested ? '轨迹：先策划采集范围、场景覆盖和质量检查，再判断可实施方案。' : `轨迹：只核对以下当前版本 Run，并区分诊断证据与后续独立比较 Run：${sourceRunIds.join('、')}。`,
      request.type === 'medium'
        ? `决策基模型：${medium?.base_model_mode === 'suggest' ? '请助手建议' : medium?.base_model_id || '待核对'}；修订版：${medium?.base_model_revision || '待固定'}。训练服务器：${medium?.training_server_mode === 'later' ? '稍后配置' : `${medium?.training_server_mode === 'registered' ? `登记资源 ${medium.server_name || medium.server_id}` : '新连接'}，${medium?.server_host || '待填写'}:${medium?.server_port || '待填写'}，SSH 用户 ${medium?.ssh_user || '待填写'}，工作目录 ${medium?.work_dir || '待填写'}，认证方式 ${medium?.ssh_auth_method || '待确定'}，凭据引用 ${medium?.credential_ref || '待补充'}`}。凭据仅按引用标识处理，不在会话中索取或输出原文。`
        : `未覆盖场景：${low?.uncovered_policy === 'request_human' ? '暂停并请求人工处理' : '中止并报告'}；不自动回退大模型。其他要求：${low?.requirements || '无'}。`,
      ...(request.advanced ? [`其他限制与验收关注点：${request.advanced}`] : []),
      '请先核对真实固定父版、轨迹、工具合同与可比性；列出待补充信息、实施步骤、独立 Case 和质量/资源验收方法。近似等效和资源收益是待验证目标，不能当作当前结论。',
    ].join('\n')
    await onAssistant(task, {
      page: 'agents', tab: 'compute-variants', skill: 'compute-variant-research', workflow: 'compute-variants',
      planning_intent: 'plan_only', request_id: request.requestId,
      agent_id: agentId, agent_name: displayAgent, experiment_id: experimentId, version_label: displayVersion,
      source_ref_hint: context.parent_ref, variant_type: request.type, variant_name: variantName, goal: request.goal.trim(),
      source_run_ids: sourceRunIds, trace_collection_plan_requested: request.tracePlanRequested, advanced: request.advanced,
      ...(medium ? { medium } : {}), ...(low ? { low } : {}),
      acceptance: { equivalence: 'target_to_verify', independent_comparison_required: true, resource_savings: 'to_measure' },
    })
  }
  const comparisonBody = { experiment_id: experimentId, parent_run_ids: parentRuns, variant_run_ids: variantRuns }
  return <section aria-label="算力变体" className="compute-variant-panel">
    <header className="compute-heading"><h3>算力变体</h3><div className="compute-heading-actions"><span className="compute-source-tag">基于 {displayVersion} 策划</span><button className="compute-refresh" aria-label="刷新计划与 Run" title="更新当前计划和封存 Run 列表" disabled={busy} onClick={() => void action(async () => {
      const request = generation.current, value = await invoke('context', { experiment_id: experimentId })
      if (request !== generation.current) return
      setParentRef(value.parent_ref); setSelectedCases(value.cases.map((item: any) => item.case_id)); setCritical([])
      restoreContext(value); setFreezePreview(null); setGeneratedCode(null); setMessage('已更新计划与封存 Run 列表。')
    })}>刷新</button></div></header>
    <div className="compute-guidance"><div className="compute-guidance-eyebrow"><ComputeIcon kind="sparkle" /><strong>让运行经验成为更轻量的实现</strong></div><h4>{!context ? error ? '当前版本暂不可用' : '正在读取当前版本' : context.plan ? '围绕已有计划继续研究' : '先定义路线，再验证效果'}</h4><p>{!context ? error ? '读取失败，请查看提示并刷新重试。' : '正在读取计划和封存 Run，请稍候。' : context.plan ? '查看已保存计划和真实 Run，再独立比较效果与资源；近似等效仍需评测和人工复核。' : '选择中算力或低算力路线，由平台 AI 助手根据已有轨迹策划实现与比较方案。近似等效是待验证目标。'}</p><div className="compute-actions">
    <button type="button" className="compute-primary" disabled={busy || !context || !onAssistant} onClick={() => context?.plan ? void action(async () => {
      await onAssistant?.('请使用 compute-variant-research 分析当前算力变体的冻结计划、实际资产和已有 Run；解释效果与资源差异、可比性和缺口，提出下一步。先只读取证，不修改计划、不运行评测，不替我确认近似等效或 end。',
        { page: 'agents', tab: 'compute-variants', agent_id: agentId, experiment_id: experimentId, skill: 'compute-variant-research', workflow: 'compute-variants', variant_name: selectedVariantName ?? null, parent_run_ids: parentRuns, variant_run_ids: variantRuns })
    }) : setPlanningOpen(true)}>{context?.plan ? '请 AI 分析算力变体' : <><ComputeIcon kind="sparkle" />请 AI 策划算力变体</>}</button>
      {context?.plan && context.generation && <button type="button" disabled={busy || !onAssistant} onClick={() => void action(async () => {
        await onAssistant?.('请使用 compute-variant-research，在当前已派生目标生成并验证 LangGraph TypeScript 代码变体。保留已确定的 variant_name，不用策略正文替换名称；从当前上下文回读名称，名称缺失时先说明。核对已保存计划、固定父版、实际工具schema和来源轨迹，再用 platform_task preview/start 提出 kind=compute-variant 连续任务。确认后保存实际代码、构建、展示真实数据Git差异并单独确认冻结，执行两侧固定Case并核对装载与完整资源记录。完成用实际Run比较，不替我确认end。', { page: 'agents', tab: 'compute-variants', skill: 'compute-variant-research', workflow: 'compute-variants', agent_id: agentId, experiment_id: experimentId, variant_name: selectedVariantName ?? null, generation_intent: 'implement' })
      })}>请 AI 生成代码变体</button>}
    </div>{planningDirty && !planningOpen && !context?.plan && <p className="compute-draft-note">本次页面内有策划草稿，再次点击可继续填写。</p>}</div>
    <ol className="compute-workflow" aria-label="算力变体研究流程"><li><strong>选择技术路线</strong><span>理解两类变体的实现方式</span></li><li><strong>补充策划信息</strong><span>引用轨迹、模型与训练资源</span></li><li><strong>与 AI 助手策划</strong><span>确认数据与实现方案</span></li><li><strong>独立比较与验收</strong><span>评估效果、覆盖与资源开销</span></li></ol>
    {context && <div className="compute-related-run"><ComputeIcon kind="run" /><div><strong>{displayVersion} · {latestRun?.title || (latestRun ? '最近封存 Run' : '运行轨迹')}</strong><p>{latestRun ? <>运行记录 <a href={navigationHash({ page: 'evaluation', tab: 'runs', agent_id: agentId, experiment_id: experimentId, run_id: latestRun.run_id })} target="_blank" rel="noopener noreferrer">{latestRun.run_id}</a> · {latestRun.created_at || '时间未记录'}；可作为本次策划的诊断轨迹，比较仍需新 Run。</> : '当前版本尚无封存 Run，可先在评测中心采集轨迹。'}</p></div><span className="compute-run-status" data-status={latestRun?.status === 'completed' ? latestRun.effective_verdict === 'passed' ? 'completed' : latestRun.effective_verdict === 'failed' ? 'failed' : 'empty' : latestRun?.status || 'empty'}>{latestRun ? runOutcome(latestRun) : '待采集'}</span></div>}
    {context && !context.plan && <p className="compute-empty-variants"><ComputeIcon kind="info" />当前版本尚未保存算力变体计划。</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!context && !error && <p>正在读取计划与 Run…</p>}
    <details key={experimentId} className="compute-more"><summary>其他策划方式</summary><div className="compute-alternate-action"><button type="button" className="compute-secondary" aria-expanded={createOpen} aria-controls="compute-manual-plan" disabled={busy || !context} onClick={() => { setCreateOpen(value => !value); setManualPreview(null) }}>{createOpen ? '收起手动计划' : context?.plan ? '手动派生新变体' : '手动制定计划'}</button></div>
    {createOpen && context && <fieldset id="compute-manual-plan" className="compute-form" disabled={busy} onChange={() => setManualPreview(null)}>
      <legend>手动制定比较计划</legend>
      <p className="agent-muted">与 AI 策划使用同一派生流程。填写后先检查预览，再确认创建。</p>
      <div className="harness-fields">
        <label className="agent-field agent-field-wide">变体名称<input aria-label="变体名称" required value={variantName} onChange={event => setVariantName(event.target.value)} placeholder="例如：资产告警轻量版" /></label>
        <label className="agent-field">完整父版<select value={parent} onChange={event => { setParent(event.target.value); setSourceRuns([]) }}>{versions.map(version => <option key={version.id} value={version.id}>{version.id}</option>)}</select></label>
        <label className="agent-field">可恢复的 Git 父版引用<input value={parentRef} onChange={event => setParentRef(event.target.value)} placeholder="git:<40 位提交>" /></label>
        <label className="agent-field agent-field-wide">策略与研究问题<textarea aria-label="策略与研究问题" value={strategy} onChange={event => setStrategy(event.target.value)} placeholder="例如减少重复查询和上下文，完整保留查询结果；说明哪些行为允许变化。" rows={3} /></label>
      </div>
      <label><input aria-label="生成 LangGraph 代码变体" type="checkbox" checked={codeMode} onChange={event => { setCodeMode(event.target.checked); if (event.target.checked) setMetric('actual_model_calls' as ComputeMetric) }} />生成 LangGraph 代码变体</label>
      {codeMode && <fieldset><legend>固定父版的诊断轨迹</legend><p className="agent-muted">选择用于提取稳定流程的真实 Run，比较仍需另起两侧独立运行。</p>{context.runs.filter(run => run.experiment_id === parent).map(run => <label key={run.run_id}><input aria-label={`生成来源 ${run.run_id}`} type="checkbox" checked={sourceRuns.includes(run.run_id)} onChange={() => setSourceRuns(values => toggle(values, run.run_id))} />{run.run_id}</label>)}{!context.runs.some(run => run.experiment_id === parent) && <p>该父版尚无诊断 Run，请先运行业务 Case。</p>}</fieldset>}
      <div className="compute-case-table"><table><thead><tr><th>任务范围</th><th>关键任务</th><th>Case</th></tr></thead><tbody>{context.cases.map(item => <tr key={item.case_id}>
        <td><input aria-label={`纳入 ${item.case_id}`} type="checkbox" checked={selectedCases.includes(item.case_id)} onChange={() => { setSelectedCases(values => toggle(values, item.case_id)); setCritical(values => values.filter(value => value !== item.case_id)) }} /></td>
        <td><input aria-label={`关键 ${item.case_id}`} type="checkbox" disabled={!selectedCases.includes(item.case_id)} checked={critical.includes(item.case_id)} onChange={() => setCritical(values => toggle(values, item.case_id))} /></td>
        <td>{item.case_id} · {item.title}</td>
      </tr>)}</tbody></table></div>
      <div className="harness-fields">
        <label className="agent-field">每 Case 每侧最少独立 Run<input type="number" min={1} max={100} value={minimum} onChange={event => setMinimum(Number(event.target.value))} /></label>
        <label className="agent-field">允许通过率下降（百分点）<input type="number" min={0} max={100} value={drop} onChange={event => setDrop(Number(event.target.value))} /></label>
        <label className="agent-field">目标资源指标<select value={metric} onChange={event => setMetric(event.target.value as ComputeMetric)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="agent-field">最低资源改善（%）<input type="number" min={0.01} max={100} step={0.01} value={reduction} onChange={event => setReduction(Number(event.target.value))} /></label>
      </div>
      <label><input type="checkbox" checked={modelChange} onChange={event => setModelChange(event.target.checked)} /> 显式允许模型或推理强度变化</label>
      {modelChange && <div className="harness-fields"><label className="agent-field">目标模型<input value={model} onChange={event => setModel(event.target.value)} /></label><label className="agent-field">目标推理强度<input value={reasoning} onChange={event => setReasoning(event.target.value)} /></label></div>}
      <p className="agent-muted">派生会完整继承固定父版。默认继承固定父版的实际模型与推理配置；此计划不会自动修改模型或业务资产。创建后在 Harness 资产中实现策略，将数据仓库中的计划与 Candidate 提交到 Git，再分别评测父版和变体。已有旧 Run 可查看，但不能追认为预先冻结的比较。</p>
      <div className="compute-actions"><button className="compute-primary" disabled={!variantName.trim() || !strategy.trim() || !selectedCases.length || !parentRef.trim() || codeMode && !sourceRuns.length} onClick={() => void action(async () => {
        const request = generation.current
        const input = { agent_id: agentId, variant_name: variantName.trim(), parent_experiment_id: parent, parent_ref: parentRef, strategy, case_ids: selectedCases, critical_case_ids: critical, min_runs_per_case: minimum, max_pass_rate_drop_pp: drop, resource_metric: metric, min_resource_reduction_pct: reduction, allow_model_change: modelChange, variant_model: model, variant_reasoning_effort: reasoning, ...(codeMode ? { generation: { mode: 'langgraph-aot', entry_path: 'dsh/managed/compute-workflow/index.ts', source_run_ids: sourceRuns } } : {}) }
        const value = await invoke('preview', input)
        if (request === generation.current) setManualPreview({ input, value })
      })}>预览派生计划</button></div>
      {manualPreview && <div className="compute-plan-preview" role="region" aria-label="派生计划预览">
        <h4>确认这次派生</h4>
        <p>变体名称：{manualPreview.value.variant_name}</p>
        <p>父版：{manualPreview.value.parent_experiment_id}</p>
        <p>研究策略：{manualPreview.value.plan.strategy}</p>
        <p>任务 {Object.keys(manualPreview.value.plan.case_hashes).length} 项，每侧至少 {manualPreview.value.plan.min_runs_per_case} 次独立 Run；{labels[manualPreview.value.plan.resource_metric as ComputeMetric]} 目标改善 {manualPreview.value.plan.min_resource_reduction_pct}%。</p>
        <p className="agent-muted">将完整继承固定父版并保存研究计划。创建后仍需实现优化策略和独立评测。</p>
        <button className="compute-primary" onClick={() => void action(async () => {
          const request = generation.current
          const value = await invoke('create', { ...manualPreview.input, expected_preview_sha256: manualPreview.value.preview_sha256 })
          if (request !== generation.current) return
          setMessage(`已创建探索变体 ${value.experiment_id}。请实现策略并固定计划后评测。`); setCreateOpen(false); setManualPreview(null); onCreated?.(value.experiment_id); onChanged?.()
        })}>确认创建探索性变体</button>
      </div>}
    </fieldset>}</details>
    {context?.plan && <div className="compute-plan-workspace">
      <div className="compute-plan-summary"><div className="compute-plan-summary-top"><span>已保存的研究计划</span><span className="compute-run-status" data-status={context.decision === 'end' ? 'completed' : 'empty'}>{context.decision === 'end' ? '已确认结论' : context.decision === 'continue' ? '继续研究' : '证据待补充'}</span></div>
        <h4>变体名称：{selectedVariantName || '未命名变体'}</h4>
        <p>研究策略：{context.plan.strategy}</p>
        <p>父版：{context.parent_experiment_id || '未记录'}；当前阶段：{context.variant_kind === 'end' ? '已标记 end' : '探索性变体'}。</p>
        <details><summary>查看固定来源引用</summary><code>{context.fixed_parent_ref || '未记录'}</code></details>
      </div>
      {context.generation && <section aria-label="代码变体生成进度"><ol>{([['generated', '代码已保存'], ['built', '构建已核对'], ['frozen', '数据提交已冻结'], ['loaded', '新 Session 已装载'], ['compared', '实际 Run 已比较']] as const).map(([key, title]) => <li key={key}>{title}：{context.workflow_status?.[key] === true || key === 'compared' && comparison?.comparison_receipt ? '已验证' : '尚未验证'}</li>)}</ol>
        <p className="agent-muted">状态来自实际文件、构建回执和 Run；保存源码不代表已装载或已节省资源。</p>
        {context.build?.error && <p role="alert">{context.build.error}</p>}
        <button disabled={busy || !context.workflow_status?.generated} onClick={() => void action(async () => {
          const result = await rpc.call(CHANNEL, 'agents/edit/read', { experiment_id: experimentId, path: `candidate/${context.generation!.entry_path}` }) as Result
          if (!result.ok) throw new Error(result.error.message)
          setGeneratedCode(result.value)
        })}>查看生成代码</button>
        <button disabled={busy || !context.workflow_status?.built} onClick={() => void action(async () => { setFreezePreview(await invoke('freeze-preview', { experiment_id: experimentId, ...(context.candidate_sha256 ? { expected_candidate_sha256: context.candidate_sha256 } : {}) })) })}>预览冻结差异</button>
        {generatedCode && <details open><summary>生成的 TypeScript 源码</summary><pre>{generatedCode.content}</pre></details>}
        {freezePreview && <div><p>将预览列出的计划、生成源码和产物固定到本地数据 Git。</p><details open><summary>查看本次冻结的实际差异</summary><pre>{freezePreview.diff ?? JSON.stringify(freezePreview.files ?? freezePreview, null, 2)}</pre></details><button disabled={busy || !freezePreview.preview_sha256} onClick={() => void action(async () => {
          await invoke('freeze', { ...(freezePreview.freeze_input ?? {}), experiment_id: experimentId, expected_preview_sha256: freezePreview.preview_sha256, confirmed: true }); setFreezePreview(null); restoreContext(await invoke('context', { experiment_id: experimentId })); onChanged?.()
        })}>确认冻结本次差异</button></div>}
      </section>}
      <p className="agent-muted">范围：{Object.keys(context.plan.case_hashes).join('、')}；关键任务：{context.plan.critical_case_ids.join('、') || '未指定'}；每侧至少 {context.plan.min_runs_per_case} 次独立 Run；允许下降 {context.plan.max_pass_rate_drop_pp} 个百分点；{labels[context.plan.resource_metric]} 至少改善 {context.plan.min_resource_reduction_pct}%。</p>
      <p className="agent-muted">评测前需在数据仓库提交冻结计划。确认 end 前还需提交当前 Candidate。通过现有“运行评测”分别执行两侧相同 Case；旧 Run 或不足的重复次数会明确显示限制。</p>
      <h4 className="compute-section-heading">选择独立 Run 进行比较</h4>
      <div className="harness-fields">{(['parent', 'variant'] as const).map(side => {
        const rows = context.runs.filter(run => run.experiment_id === (side === 'parent' ? context.parent_experiment_id : experimentId))
        const selected = side === 'parent' ? parentRuns : variantRuns
        return <fieldset key={side} disabled={busy} className="compute-run-group"><legend>{side === 'parent' ? '父版封存 Run' : '变体封存 Run'}</legend>
          <div className="compute-run-list">{rows.length ? rows.map(run => <label key={run.run_id}><input aria-label={`${side} ${run.run_id}`} type="checkbox" checked={selected.includes(run.run_id)} onChange={() => changeRuns(side, run.run_id)} />{run.title || '运行记录'} · {runOutcome(run)}<span className="agent-muted">Run {run.run_id} · {run.created_at || '时间未记录'}</span></label>) : <p className="agent-muted">尚无封存 Run，请从现有评测入口运行。</p>}</div>
        </fieldset>
      })}</div>
      <button disabled={busy || !parentRuns.length || !variantRuns.length} onClick={() => void action(async () => { const request = generation.current; const value = await invoke('compare', comparisonBody); if (request === generation.current) { setComparison(value); setHumanConfirmed(false) } })}>比较实际效果与资源</button>
    </div>}
    {comparison && <div className="compute-comparison">
      {comparison.comparison_receipt && <details><summary>不可变机器比较回执</summary><pre>{JSON.stringify(comparison.comparison_receipt, null, 2)}</pre></details>}
      <details><summary>打开所选 Run 的完整报告与工具证据</summary><ul>{[...parentRuns, ...variantRuns].map(runId => <li key={runId}><a href={navigationHash({ page: 'evaluation', tab: 'runs', agent_id: agentId, experiment_id: context?.runs.find(run => run.run_id === runId)?.experiment_id, run_id: runId })} target="_blank" rel="noopener noreferrer">{runId}</a></li>)}</ul></details>
      <p role="status">功能质量：{comparison.quality.passed ? '满足预定观察指标' : comparison.quality.cases.some((row: any) => row.parent_pass_rate === null || row.parent_pass_rate === undefined || row.variant_pass_rate === null || row.variant_pass_rate === undefined) ? '证据不足' : '未满足预定观察指标'}；资源目标：{resourceOutcome}；可比性：{comparison.comparability.passed ? '记录条件一致' : '存在限制'}。</p>
      <div className="compute-table-scroll"><table><thead><tr><th>Case</th><th>独立 Run 父 / 变体</th><th>通过率父 / 变体</th><th>关键任务</th><th>质量</th></tr></thead><tbody>{comparison.quality.cases.map((row: any) => <tr key={row.case_id}><td>{row.case_id}</td><td>{row.parent_runs} / {row.variant_runs}</td><td>{percentage(row.parent_pass_rate)} / {percentage(row.variant_pass_rate)}</td><td>{row.critical ? '是' : '否'}</td><td>{row.parent_pass_rate === null || row.parent_pass_rate === undefined || row.variant_pass_rate === null || row.variant_pass_rate === undefined ? '证据不足' : row.quality_passed ? '满足' : '未满足'}</td></tr>)}</tbody></table></div>
      <div className="compute-table-scroll"><table><thead><tr><th>资源指标（各 Case 等权平均）</th><th>父版</th><th>变体</th><th>改善率</th></tr></thead><tbody>{Object.entries(labels).map(([key, label]) => { const value = comparison.resources[key]; return <tr key={key}><td>{label}</td><td>{display(value?.parent)}</td><td>{display(value?.variant)}</td><td>{value?.reduction_pct === null || value?.reduction_pct === undefined ? '未知' : `${display(value.reduction_pct)}%`}</td></tr> })}</tbody></table></div>
      {!!comparison.comparability.limits.length && <details open><summary>阻断可比性的证据缺口</summary><ul>{comparison.comparability.limits.map((limit: string) => <li key={limit}>{limit}</li>)}</ul></details>}
      {!!comparison.resource_evidence.limits.length && <details open><summary>资源记录限制</summary><ul>{comparison.resource_evidence.limits.map((limit: string) => <li key={limit}>{limit}</li>)}</ul></details>}
      <div className="agent-muted">{comparison.notes.map((note: string) => <p key={note}>{note}</p>)}</div>
      <label><input aria-label="已审阅完整效果与工具结果" type="checkbox" checked={humanConfirmed} disabled={busy} onChange={event => setHumanConfirmed(event.target.checked)} />我已在评测中心核对所选 Run 的完整输出、工具结果、任务效果和比较限制。</label>
      <label className="agent-field">研究结论及限制<textarea aria-label="变体研究结论" value={reason} onChange={event => setReason(event.target.value)} rows={3} disabled={busy} /></label>
      <div className="agent-actions">{(['continue', 'inconclusive', 'end'] as const).map(decision => <button key={decision} disabled={busy || !humanConfirmed || !reason.trim() || decision === 'end' && !comparison.eligible_for_end} onClick={() => void action(async () => {
        const request = generation.current
        const value = await invoke('confirm', { ...comparisonBody, decision, human_confirmed: humanConfirmed, reason, comparison_sha256: comparison.comparison_sha256 })
        if (request !== generation.current) return
        setMessage(`已记录 Decision ${value.decision}，版本类型 ${value.variant_kind}。`); setComparison(null); setHumanConfirmed(false); const refreshed = await invoke('context', { experiment_id: experimentId }); if (request === generation.current) { restoreContext(refreshed); onChanged?.() }
      })}>{decision === 'end' ? '确认近似等效并标记 end' : decision === 'continue' ? '记录继续研究' : '记录证据不足'}</button>)}</div>
    </div>}
    {context && <ComputePlanningDialog rpc={rpc} open={planningOpen} agentName={displayAgent} agentId={agentId} experimentId={experimentId} versionLabel={displayVersion} parentRef={context.parent_ref} runs={selectedRuns} onClose={() => setPlanningOpen(false)} onSend={sendPlanning} onDirtyChange={setPlanningDirty} themeScheme={themeScheme} onThemeToggle={onThemeToggle} />}
  </section>
}
