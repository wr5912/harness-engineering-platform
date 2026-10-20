import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL } from '../protocol.ts'
import type { TaskExecution } from './task.ts'
import { instanceWebUrl } from '../instances/url.ts'
import { operationSummary, type OperationMeta } from './operation-summary.ts'

type SessionId = Parameters<Context['sessions']['binding']>[0]
type SessionReference = ReturnType<Context['sessions']['retain']>
export type AssistantContext = Record<string, unknown>

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { harnessAssistant: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'harness.assistant.conversation': { kind: 'single'; scope: 'session-maybe' }
  }
}

interface AssistantSnapshot {
  sessionId?: SessionId
  reference?: SessionReference
  platformContext?: boolean
  busy: boolean
  error: string
  status?: { running?: boolean; execution?: TaskExecution; proposals?: { id: string; state: OperationMeta['state']; domain: string; action: string; input?: Record<string, any>; preview?: unknown; result?: unknown; error?: string }[] }
}

/** 浏览器只保留当前会话引用，任务与业务结果由原生 Session 和后端维护。 */
export function createAssistant(ctx: Pick<Context, 'sessions' | 'uiSession' | 'uiWorkspace' | 'workspaces'>, rpc: ClientConnectionRpc, getRoot: () => string | undefined, getLegacyRoots: () => string[] = () => []) {
  let snapshot: AssistantSnapshot = { busy: false, error: '' }
  let context: AssistantContext = { page: 'home' }
  let generation = 0
  let refreshGeneration = 0
  let contextPending = false
  let contextSyncing = false
  let selecting = false
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<AssistantSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const isProjectSession = (sessionId: SessionId) => {
    const root = getRoot()
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    return Boolean(root && cwd && [root, ...getLegacyRoots()].includes(cwd))
  }
  const refresh = async () => {
    const sessionId = snapshot.sessionId
    if (!sessionId || snapshot.platformContext === false || disposed) return
    const current = generation
    const request = ++refreshGeneration
    try {
      const response = await rpc.call(CHANNEL, 'assistant/status', { session_id: sessionId })
      if (!disposed && generation === current && request === refreshGeneration && response.ok) publish({ status: response.value as AssistantSnapshot['status'] })
    } catch { /* 原生连接重连和下一次失效通知会重新读取。 */ }
  }
  async function syncContext() {
    contextPending = true
    if (contextSyncing) return
    contextSyncing = true
    try {
      while (contextPending && !disposed) {
        contextPending = false
        const sessionId = snapshot.sessionId
        const next = context
        if (!sessionId || snapshot.platformContext === false) continue
        try {
          const response = await rpc.call(CHANNEL, 'assistant/context', { session_id: sessionId, context: next })
          if (!response.ok && snapshot.sessionId === sessionId && context === next) publish({ error: response.error.message })
        } catch { if (snapshot.sessionId === sessionId && context === next) publish({ error: '页面上下文同步失败，请检查连接。' }) }
      }
    } finally { contextSyncing = false }
  }
  const select = async (sessionId: SessionId, navigate = true) => {
    if (snapshot.sessionId === sessionId && snapshot.reference) {
      if (navigate) ctx.uiWorkspace.openSession(sessionId)
      await refresh()
      return
    }
    const current = ++generation
    selecting = true
    try {
      const reference = ctx.sessions.retain(sessionId, { source: 'harnessAssistant' })
      snapshot.reference?.release()
      publish({ sessionId, reference, platformContext: navigate || isProjectSession(sessionId), status: undefined, error: '' })
      void syncContext()
      await reference.ready
      if (current === generation && !disposed) { if (navigate) ctx.uiWorkspace.openSession(sessionId); await refresh() }
    }
    catch (error) {
      if (current === generation && !disposed) publish({ error: error instanceof Error ? error.message : '无法读取助手会话，请重试。' })
      if (navigate) throw error
    } finally { if (current === generation) selecting = false }
  }
  const restore = () => {
    if (disposed || selecting || snapshot.busy) return
    const sessionId = ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
    if (!sessionId && snapshot.sessionId) {
      generation++
      snapshot.reference?.release()
      publish({ sessionId: undefined, reference: undefined, platformContext: false, status: undefined, error: '' })
    }
    if (sessionId && snapshot.sessionId !== sessionId) void select(sessionId, false)
    else if (sessionId && snapshot.platformContext !== isProjectSession(sessionId)) {
      publish({ platformContext: isProjectSession(sessionId), status: undefined, error: '' })
      void syncContext()
      void refresh()
    }
  }
  const subscriptions = [ctx.uiSession.adapter.current.subscribe(restore), ctx.sessions.list.subscribe(restore)]
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    select,
    refresh,
    restore,
    reveal() { if (snapshot.sessionId) ctx.uiWorkspace.openSession(snapshot.sessionId) },
    async create(task?: string, taskContext: AssistantContext = context) {
      publish({ busy: true, error: '' })
      try {
        const configuration = await rpc.call(CHANNEL, 'assistant/configuration', { context: taskContext })
        if (!configuration.ok) throw new Error(configuration.error.message)
        const availability = configuration.value as { ready: boolean; message: string }
        if (!availability.ready) throw new Error(availability.message || '当前工作区未配置平台管理助手，请连接或克隆已有数据仓库。')
        const sessionIdToResume = typeof taskContext.session_id === 'string' ? taskContext.session_id : undefined
        const root = getRoot()
        if (!root) throw new Error('项目工作区尚未就绪，请稍后重试。')
        let resumeCwd: string | undefined
        if (sessionIdToResume) {
          resumeCwd = ctx.sessions.list.getSnapshot().byId[sessionIdToResume as SessionId]?.cwd
          if (!resumeCwd) {
            const status = await rpc.call(CHANNEL, 'assistant/status', { session_id: sessionIdToResume })
            if (!status.ok) throw new Error(status.error.message)
            resumeCwd = (status.value as { workspace?: { session_cwd?: string } }).workspace?.session_cwd
          }
          if (!resumeCwd || ![root, ...getLegacyRoots()].includes(resumeCwd)) throw new Error('助手会话不属于当前工作区')
        }
        const workspace = sessionIdToResume ? undefined : await ctx.workspaces.create({ path: root })
        // 原生 create/adopt 会在返回前登记客户端身份，不依赖异步列表通知到达顺序。
        const preparedSessionId = await ctx.sessions.create(sessionIdToResume
          ? { sessionId: sessionIdToResume as SessionId, cwd: resumeCwd }
          : { workspaceId: workspace!.workspaceId })
        await ctx.sessions.using(preparedSessionId, { source: 'harnessAssistant' }, async () => {
          if (disposed) return
          const response = await rpc.call(CHANNEL, 'assistant/session', {
            task, context: taskContext, session_id: preparedSessionId,
          })
          if (!response.ok) throw new Error(response.error.message)
          const sessionId = (response.value as { session_id: SessionId }).session_id
          if (!sessionId) throw new Error('助手未返回会话标识，请重试。')
          if (sessionId !== preparedSessionId) throw new Error('助手返回的会话与已建立的会话不一致，请重试。')
          if (!disposed) await select(sessionId)
        })
      } catch (error) {
        if (!disposed) publish({ error: error instanceof Error ? error.message : '无法创建助手会话。' })
        throw error
      } finally { if (!disposed) publish({ busy: false }) }
    },
    updateContext(next: AssistantContext) {
      if (JSON.stringify(context) === JSON.stringify(next)) return
      context = next
      void syncContext()
    },
    async reconnect() {
      const sessionId = snapshot.sessionId
      if (!sessionId || disposed) return
      snapshot.reference?.release()
      publish({ reference: undefined })
      await select(sessionId, false)
    },
    dispose() { disposed = true; generation++; subscriptions.forEach(dispose => dispose()); snapshot.reference?.release(); listeners.clear() },
  }
}
export type Assistant = ReturnType<typeof createAssistant>

function ChatView({ renderSlot }: ConversationViewsProps) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Factory 复用原生消息、附件、问答、权限确认及 Composer。 */
export function AssistantConversation({ useSession, useConversation, renderFactorySlot }: PropsRuntime<'harness.assistant.conversation'> & PropsRenderFactories) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = Boolean(session && (session.running || !session.blank || session.promptAttempted)) || Boolean(conversation?.activeTargets.size)
  const hero = !active
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: hero ? 'hero' : 'active', hero }, { slots: { views: ChatView } })
}

const domainLabels: Record<string, string> = { agents: '智能体与评测', instances: '实例', mcp: 'MCP', task: '智能体交付任务' }
const labels: Record<string, string> = {
  agent_id: '智能体', experiment_id: '版本', baseline: '主父版', sources: '关联来源', features: '特性',
  action: '操作', operation: '操作', name: '名称', instance: '实例', instance_name: '实例', source: '来源',
  title: '说明', goal: '目标', validation: '验证', warnings: '提示', summary: '摘要', status: '状态',
  success: '成功', failed: '失败', ok: '成功', message: '说明', result: '回执', receipts: '逐项回执',
  description: '说明', input: '修改内容', ops: '配置修改', op: '修改方式', path: '配置位置', value: '内容',
  revision: '配置版本', before: '原有特性', source_refs: '特性来源', evidence_refs: '验证依据', change: '本版变化',
  compositionId: '工具组合', versionId: '固定发布版本', toolName: '工具名称',
}
const internalFields = new Set(['preview_id', 'proposal_id', 'assistant_session_id', 'catalog_hash', 'plan_ready', 'requires_confirmation', 'evaluation_sha256', 'candidate_sha256', 'source_sha256'])
const technicalFields = new Set(['command', 'argv', 'cwd', 'stdout', 'stderr', 'logs', 'trace'])
const actionLabels: Record<string, string> = { start: '开始交付任务', create: '从固定父版派生', 'tasks/assembly-apply': '装配复用能力', saveConfiguration: '保存 MCP 配置', callPublishedComposition: '执行固定版本工具组合', 'fusion/confirm': '新建融合版本', 'features/apply': '保存版本特性', 'datasets/apply': '保存待复核决策样本', 'cases/create': '新增测试用例', new: '新建智能体', 'edit/apply': '保存资产修改', 'eval/start': '执行评测', 'eval/cancel': '取消评测', run: '实例操作', batch: '批量实例操作' }

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ok' in value && 'value' in value && value.ok === true) return value.value
  return value
}

function Details({ value, includeIdentifiers = false }: { value: unknown; includeIdentifiers?: boolean }) {
  if (value === null || value === undefined) return <span>未提供</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}><Details value={item} includeIdentifiers={includeIdentifiers}/></li>)}</ul> : <span>无</span>
  if (typeof value === 'object') return <dl>{Object.entries(value).filter(([key]) => includeIdentifiers || !internalFields.has(key)).map(([key, item]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{technicalFields.has(key) ? <details><summary>查看技术详情</summary><Details value={item} includeIdentifiers={includeIdentifiers}/></details> : <Details value={item} includeIdentifiers={includeIdentifiers}/>}</dd></div>)}</dl>
  return <span>{String(value)}</span>
}

function BusinessPreviewDetails({ value }: { value: unknown }) {
  return <Details value={unwrap(value)} includeIdentifiers/>
}

function versionLabel(value: unknown) {
  const text = String(value ?? '')
  return /-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(text)?.[1] ? `版本 ${/-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(text)![1]}` : text
}
function targetVersionLabel(value: unknown, data: any, input: Record<string, any>) {
  const match = /^(?:experiment:)?EXP-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{3}(?:-r[0-9a-f]{12})?$/.exec(String(value ?? ''))
  const agent = data?.agent_name ?? data?.agent_id ?? input.agent_name ?? input.agent_id ?? match?.[1]
  const version = versionLabel(value) || '所选版本'
  return agent ? `智能体“${agent}”的${version}` : version
}
function confirmationAction(meta: OperationMeta) {
  const value = unwrap(meta.preview) as any
  if (meta.domain === 'task' && meta.action === 'start' && value?.plan?.kind === 'compute-variant') return '开始生成并比较代码变体'
  if (meta.domain === 'task' && meta.action === 'start') return value?.plan?.new_agent || value?.plan?.allowed_actions?.some((item: any) => ['new', 'create', 'edit/apply', 'tasks/assembly-apply'].includes(item.action)) ? '开始构建并验证' : '开始验证并交付'
  if (meta.action === 'datasets/apply') return `保存 ${value?.count ?? value?.records?.length ?? ''} 条样本`
  if (meta.domain === 'instances' && meta.action === 'run') return ({ create: '创建实例', start: '启动实例', stop: '停止实例', restart: '重启实例', delete: '删除实例' } as Record<string, string>)[meta.input?.operation ?? value?.operation ?? value?.input?.operation] ?? '执行实例操作'
  return ({ 'features/apply': '保存特性', 'decision/update': '保存研究结论', saveConfiguration: '保存 MCP 配置', 'fusion/confirm': '创建融合版本', create: '创建研究版本', new: '创建智能体', 'edit/apply': '保存修改', 'eval/start': '开始评测', callPublishedComposition: '执行工具组合', callTool: '调用工具', publishComposition: '发布工具组合', saveCompositionDraft: '保存组合草稿', 'cases/update': '保存测试用例', 'cases/create': '保存测试用例', 'compute-variants/create': '创建算力变体', 'compute-variants/build': '构建代码变体', 'compute-variants/freeze': '确认冻结本次数据差异' } as Record<string, string>)[meta.action] ?? actionLabels[meta.action] ?? '执行此操作'
}

/** 确认的是动作、对象及后果；完整证据与字段保留在可展开详情中。 */
function BusinessPreview({ value, meta }: { value: unknown; meta: OperationMeta }) {
  const data = unwrap(value) as any
  const input = meta.input ?? data?.input ?? {}
  const plan = data?.plan
  let summary: any
  if (plan?.goal && Array.isArray(plan.evaluation_case_ids)) {
    const parent = plan.source ? versionLabel(plan.source) : undefined
    const name = data.agent_name ?? plan.agent_id
    const declarations = [...(plan.artifact_paths ?? []), ...(plan.deliverables ?? [])].join('\n')
    const products = [...(/markdown|\.md\b/i.test(declarations) ? ['Markdown 报告'] : []), ...(/\bcsv\b/i.test(declarations) ? ['设备 CSV'] : []), ...(plan.instance_name ? ['可访问的智能体实例'] : [])]
    const lead = String(plan.goal).split(/[。；\n：]/)[0]
    summary = <>
      <p><strong>{lead}</strong></p>
      <p>{plan.kind === 'compute-variant' ? `为“${name}”的${parent}生成实际工作流代码，并与固定父版比较` : plan.new_agent ? `新建“${plan.new_agent.name}”` : plan.allowed_actions.some((item: any) => item.action === 'create') ? `为“${name}”从${parent}派生新版本` : `${plan.allowed_actions.some((item: any) => ['edit/apply', 'tasks/assembly-apply'].includes(item.action)) ? '改进' : '验证'}“${name}”的${parent}`}，执行 {plan.evaluation_case_ids.length} 项测试。</p>
      <p><strong>交付：</strong>{products.length ? products.join('、') : plan.deliverables.join('、')}。</p>
      <p className="harness-confirmation-budget"><strong>上限：</strong>{plan.budget.timeout_minutes} 分钟、初测后最多修复 {plan.budget.max_repair_rounds} 轮、模型调用 {plan.budget.max_model_calls} 次。<small>暂停和重启不重置。助手逐次控制调用额度；外部评测按实际轨迹累计，不能实时硬封顶。</small></p>
      <small>确认后在本方案内连续办理约定操作，范围详见完整方案。</small>
      {plan.kind === 'compute-variant' && <p>数据 Git 提交会另行展示具体差异并确认；本任务完成不代表已确认近似等效或 end。</p>}
    </>
  } else if (data?.status === 'suggested' && Array.isArray(data.records)) summary = <>
    <p>将 <strong>{data.count ?? data.records.length} 条决策样本</strong>保存到本次运行的“决策样本”。</p>
    <p>业务范围：{[...new Set(data.records.map((record: any) => record.workflow).filter(Boolean))].join('、') || '当前固定运行中的业务决策'}；共 {data.records.reduce((count: number, record: any) => count + Object.keys(record.questions ?? {}).length, 0)} 道命名决策题。</p>
    <p>标签仍是 AI 建议，保存后待人员逐题复核，再明确训练或评测用途。</p>
  </>
  else if (meta.action === 'features/apply') {
    const features = data?.features ?? data?.after?.features ?? []
    const removed = (data?.before?.features ?? []).filter((feature: any) => !features.some((next: any) => next.id === feature.id)).length
    summary = <><p>把 <strong>{features.length} 项特性说明</strong>保存到{targetVersionLabel(data?.experiment_id ?? input.experiment_id, data, input)}。</p>{removed > 0 && <p><strong>将移除原有的 {removed} 项特性说明。</strong></p>}<p>保存说明不会自动将能力标记为已验证；来源与证据会一并保留。</p></>
  } else if (meta.action === 'saveConfiguration') {
    const ops = data?.input?.ops ?? input.ops ?? []
    const disabled = ops.filter((op: any) => op.path?.at(-1) === 'enabled' && op.value === false).length
    const removed = ops.filter((op: any) => op.op === 'unset' && op.path?.[0] === 'servers' && op.path.length === 2).length
    summary = <><p>将 <strong>{ops.length} 项连接设置修改</strong>保存到数据仓库 MCP 配置。</p>{disabled > 0 && <p><strong>其中 {disabled} 项会停用连接，相关工具将不可调用。</strong></p>}{removed > 0 && <p><strong>将移除 {removed} 个连接及其工具入口。</strong></p>}<p>现有凭据沿用本地受控凭据文件；此操作不验证上游业务效果。</p></>
  } else if (data?.parent_experiment_id && plan) summary = <>
    <p>从{versionLabel(data.parent_experiment_id)}为 <strong>{data.agent_id}</strong>创建独立融合版本。</p>
    <p>采用 {plan.sources?.filter((source: any) => source.decision === 'inherit').length ?? 0} 个来源，纳入 {plan.features?.length ?? 0} 项特性，约定 {plan.checks?.length ?? 0} 项验证。当前版本保留，新版本须完成验证后才可交付。</p>
  </>
  else if (meta.action === 'compute-variants/freeze') summary = <><p>将预览列出的生成源码、构建产物和比较计划固定到<strong>本地数据 Git</strong>。</p><p>仅提交本次明确列出的文件；实际差异和固定来源见下方。保存提交不代表业务效果通过。</p>{typeof data?.diff === 'string' && <details open><summary>本次冻结差异</summary><pre>{data.diff}</pre></details>}</>
  else if (meta.action === 'compute-variants/build') summary = <><p>构建当前目标的 TypeScript 工作流，并核对实际产物摘要。</p><p>构建通过后仍需在新 Session 核对装载和业务效果。</p></>
  else if (meta.action === 'new') summary = <><p>创建智能体 <strong>{data?.name ?? input.name ?? data?.agent_id ?? input.agent_id}</strong>及其首个研究版本。</p><p>先保存角色和资产；可用的业务能力仍需装配与评测。</p></>
  else if (meta.action === 'edit/apply') summary = <p>向{targetVersionLabel(input.experiment_id ?? data?.experiment_id, data, input)}保存 <strong>{input.edits?.length ?? data?.files?.length ?? data?.edits?.length ?? '约定'} 份文件修改</strong>。具体内容和差异见下方。</p>
  else if (meta.action === 'decision/update') {
    const states: Record<string, string> = { active: '进行中', completed: '已完成', adopt: '采纳', continue: '继续研究', reject: '不采纳', inconclusive: '证据不足' }
    const change = data?.change
    summary = <><p>保存{targetVersionLabel(input.experiment_id, data, input)}的研究结论与依据。</p>{change && <p>状态：{states[change.before.status] ?? change.before.status} → <strong>{states[change.after.status] ?? change.after.status}</strong>；结论：{states[change.before.outcome] ?? change.before.outcome ?? '未记录'} → <strong>{states[change.after.outcome] ?? change.after.outcome ?? '未记录'}</strong>。</p>}</>
  }
  else if (meta.action === 'eval/start') summary = <><p>对{targetVersionLabel(input.source ?? data?.source, data, input)}执行 <strong>{input.cases?.length ?? data?.cases?.length ?? '约定'} 项测试</strong>，创建新的评测运行记录。</p><p>将调用已配置的模型；结果按实际执行保存。</p></>
  else if (meta.action === 'callPublishedComposition' || meta.action === 'callTool') summary = <><p>执行 <strong>{data?.title ?? data?.toolName ?? input.toolName ?? data?.compositionId ?? input.compositionId ?? '所选工具'}</strong>，请求已配置的上游接口。</p><p>使用本提案固定的工具、参数及版本；实际业务结果在执行后核对。</p></>
  else summary = <p>{operationSummary({ ...meta, state: 'awaiting_confirmation' }).title}。执行范围与实际修改保留在下方详情。</p>
  const warnings = data?.warnings ?? data?.validation?.warnings ?? []
  return <div className="harness-confirmation-summary">{summary}{Array.isArray(warnings) && warnings.map((warning: any, index: number) => <p key={index} role="note">{typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning)}</p>)}<details><summary>查看完整方案与实际修改</summary><BusinessPreviewDetails value={value}/></details></div>
}

interface OperationProps {
  meta?: OperationMeta
  phase: string
  toolName: string
  sessionId: SessionId
  rpc: ClientConnectionRpc
  assistant: Assistant
  origin?: 'dock' | 'tool'
}
function OperationCard(props: OperationProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const assistantState = useSyncExternalStore(props.assistant.subscribe, props.assistant.getSnapshot)
  const meta = props.meta
  const proposal = assistantState.sessionId === props.sessionId ? assistantState.status?.proposals?.find(item => item.id === meta?.proposal_id) : undefined
  const state = proposal?.state ?? meta?.state
  const result = proposal?.result ?? meta?.result
  const summary = operationSummary({ kind: 'platform-operation', domain: meta?.domain ?? '', action: meta?.action ?? props.toolName,
    ...meta, state: state ?? 'unknown', input: proposal?.input ?? meta?.input, result, error: proposal?.error ?? meta?.error }, props.phase)
  if (props.origin !== 'dock') return <div className="harness-operation-inline" aria-label="平台操作回执">
    {props.phase !== 'result' ? <p role="status">{summary.title}：{summary.outcome}</p> : <details className="harness-operation-result">
      <summary><strong>{summary.title}</strong><span role={summary.failed ? 'alert' : undefined}> · {summary.outcome}</span></summary>
      {result !== undefined && <Details value={unwrap(result)}/>}
      {proposal?.error && <p role="alert">{proposal.error}</p>}
    </details>}
  </div>
  return <section className="harness-operation-card" aria-label="平台操作回执">
    <header><strong>{summary.title}</strong><span>{domainLabels[meta?.domain ?? ''] ?? '平台操作'}</span></header>
    {!meta || meta.kind !== 'platform-operation' ? <p role="status">{props.phase === 'result' ? '操作已返回，请查看会话说明。' : '正在读取与处理…'}</p> : <>
      {state !== 'awaiting_confirmation' && <p className="harness-operation-state" role={summary.failed ? 'alert' : 'status'}>{summary.outcome}</p>}
      {state === 'awaiting_confirmation' && meta.preview !== undefined && <BusinessPreview value={meta.preview} meta={{ ...meta, input: proposal?.input ?? meta.input }}/>}
      {result !== undefined && <details className="harness-operation-result"><summary>查看实际操作回执</summary><Details value={unwrap(result)}/></details>}
      {proposal?.error && <p role="alert">{proposal.error}</p>}
      {state === 'awaiting_confirmation' && meta.proposal_id && <div className="harness-confirmation-actions"><button className="harness-primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); setNotice('')
        try {
          const response = await props.rpc.call(CHANNEL, 'assistant/confirm', { session_id: props.sessionId, proposal_id: meta.proposal_id })
          if (!response.ok) throw new Error(response.error.message)
          if ((response.value as { continuation?: string }).continuation === 'requires_user_message') setNotice('操作已确认执行。原会话运行已结束，请发送后续消息继续。')
          await props.assistant.refresh()
        } catch (failure) { setError(failure instanceof Error ? failure.message : '确认失败，请重试。') }
        finally { setBusy(false) }
      }}>{busy ? '正在提交…' : confirmationAction({ ...meta, input: proposal?.input ?? meta.input })}</button>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try {
          const response = await props.rpc.call(CHANNEL, 'assistant/reject', { session_id: props.sessionId, proposal_id: meta.proposal_id })
          if (!response.ok) throw new Error(response.error.message)
          await props.assistant.refresh()
        } catch (failure) { setError(failure instanceof Error ? failure.message : '暂缓失败，请重试。') }
        finally { setBusy(false) }
      }}>暂不执行</button></div>}
    </>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}

/** 原生工具结果携带的真实提案可以在原会话内确认。 */
export function PlatformOperationCard(props: ToolCallViewProps & { rpc: ClientConnectionRpc; assistant: Assistant }) {
  const block = props.block
  let args: any = { action: block.args?.text?.('action'), input: block.args?.value?.('input') }
  if (!args.action) try { args = JSON.parse(props.phase === 'result' ? props.block.call?.argsRaw ?? '{}' : props.phase === 'start' ? props.block.argsRaw : '{}') } catch { /* 流式参数尚不完整，继续展示已知工具身份。 */ }
  let payload: any, text = ''
  if (props.phase === 'result') {
    text = props.block.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
    try { payload = JSON.parse(text) } catch { /* 普通错误回执保留原文，不编造成功。 */ }
  }
  const wire = props.phase === 'result' ? props.block.meta as any : undefined
  const meta: OperationMeta = { kind: 'platform-operation', domain: props.toolName.replace(/^platform_/, ''), action: args.action ?? props.toolName,
    state: props.phase === 'result' ? props.block.isError ? 'failed' : text ? 'completed' : 'unknown' : 'running', result: payload ?? (text || undefined),
    ...(wire?.kind === 'platform-operation' ? wire : payload?.kind === 'platform-operation' ? payload : {}), input: wire?.input ?? payload?.input ?? args.input,
    ...(props.phase === 'result' && props.block.isError ? { state: 'failed', error: text || '工具执行失败，未收到完整回执' } : {}) }
  return <OperationCard {...props} meta={meta} origin="tool"/>
}

/** 原生轨迹默认折叠；待确认操作直接出现在 Composer 上方。 */
export function AssistantOperations({ assistant, rpc, sessionId }: PropsRuntime<'conversation.input.dock'> & { rpc: ClientConnectionRpc; assistant: Assistant }) {
  const state = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot)
  if (state.sessionId !== sessionId) return null
  const proposals = state.status?.proposals ?? []
  const pending = proposals.filter(item => ['awaiting_confirmation', 'running', 'unknown'].includes(item.state))
  const execution = state.status?.execution
  if (!pending.length && !execution) return null
  return <div className="harness-assistant-proposals-dock">{execution && <TaskCard task={execution} assistant={assistant} rpc={rpc} sessionId={sessionId}/>}{pending.length > 0 && <details className="harness-assistant-proposals" open>
    <summary>平台操作确认与进度</summary>
    <div>{pending.map(proposal => <OperationCard key={proposal.id} assistant={assistant} rpc={rpc} sessionId={sessionId}
      origin="dock" phase="result" toolName={`platform_${proposal.domain}`} meta={{ ...proposal, kind: 'platform-operation', proposal_id: proposal.id }}/>)}</div>
  </details>}</div>
}

function TaskCard({ task, assistant, rpc, sessionId }: { task: TaskExecution; assistant: Assistant; rpc: ClientConnectionRpc; sessionId: SessionId }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const statuses = { running: '正在执行', paused: '已暂停', cancelled: '已取消', budget_exhausted: '额度已用尽', unknown: '需要核对操作状态', completed: '已验证并交付' }
  const act = async (action: string) => {
    setBusy(true); setError('')
    try {
      const response = await rpc.call(CHANNEL, `assistant/task/${action}`, { session_id: sessionId })
      if (!response.ok) throw new Error(response.error.message)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '任务操作失败') }
    finally {
      try { await assistant.refresh() } catch (failure) { setError(previous => previous || (failure instanceof Error ? failure.message : '无法刷新任务状态')) }
      setBusy(false)
    }
  }
  return <section className="harness-operation-card" aria-label="智能体交付任务">
    <header><strong>{task.plan.kind === 'compute-variant' && task.state === 'completed' ? '生成与比较已完成' : statuses[task.state]}</strong><span>{task.plan.new_agent?.name ?? task.plan.agent_id}</span></header>
    <p>{task.plan.goal}</p>
    <p>修复 {task.repair_rounds}/{task.plan.budget.max_repair_rounds} 轮 · 已观测模型调用 {task.model_calls}/{task.plan.budget.max_model_calls} 次 · 截止 {new Date(task.deadline_at).toLocaleTimeString()}</p>
    <small>含助手 {task.assistant_model_calls ?? task.model_calls} 次，业务、评审与重试按实际轨迹累计；在途或缺失统计不按零计。外部容器调用不能实时硬封顶。</small>
    {task.reason && <p role="status">{task.reason}</p>}
    {task.operations.some(item => ['running', 'unknown'].includes(item.state)) && <button disabled={busy} onClick={() => void act('checkpoint')}>核对运行状态</button>}
    {task.state === 'running' && <button disabled={busy} onClick={() => void act('pause')}>暂停任务</button>}
    {task.state === 'paused' && <button disabled={busy} onClick={() => void act('resume')}>恢复任务</button>}
    {task.source_ref && task.operations.some(item => ['edit/apply', 'tasks/assembly-apply'].includes(item.action) && item.state === 'completed') && task.state !== 'completed' && <button disabled={busy} onClick={() => void act('rollback')}>恢复本任务资产修改</button>}
    {!['completed', 'cancelled'].includes(task.state) && <button disabled={busy} onClick={() => void act('cancel')}>取消任务</button>}
    {task.delivery && <><p>{task.plan.kind === 'compute-variant' ? '已核对本任务生成、装载和比较证据；具体效果与资源结果请查看比较，end 仍需用户复核。' : '业务测试、目标实例及产物已核验。'}</p>
      {task.delivery.entry && <p><a href={instanceWebUrl(task.delivery.entry, window.location.hostname)} target="_blank" rel="noreferrer">打开智能体</a></p>}
      {(task.delivery.artifacts ?? []).map((artifact: any) => <p key={artifact.path}><a href={(() => { const url = new URL('api/harness-platform/runs/download', document.baseURI); url.searchParams.set('run_id', task.delivery.run_id); url.searchParams.set('kind', 'file'); url.searchParams.set('path', artifact.run_path); return url.href })()} download>下载 {artifact.run_path?.split('/').at(-1) ?? '业务产物'}</a></p>)}
      {(task.delivery.probe?.downloads ?? []).map((artifact: any) => <p key={artifact.format}><a href={instanceWebUrl({ ...task.delivery.entry, url: artifact.url }, window.location.hostname)} target="_blank" rel="noreferrer" download>{artifact.format === 'csv' ? '下载设备 CSV' : '下载 Markdown'}</a></p>)}
      <details><summary>查看验证结果与限制</summary><Details value={task.delivery}/></details></>}
    {error && <p role="alert">{error}</p>}
  </section>
}
