import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL } from '../protocol.ts'
import type { RepositoryChoice, RepositorySnapshot } from './repositories.ts'

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

const submissionRequestId = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, marker => {
  const value = Math.floor(Math.random() * 16)
  return (marker === 'x' ? value : value & 3 | 8).toString(16)
})
type PendingSubmission = { root: string; sessionId: SessionId; requestId: string; task?: string; context: AssistantContext }
interface AssistantSnapshot {
  sessionId?: SessionId
  reference?: SessionReference
  platformContext?: boolean
  busy: boolean
  error: string
  repositories: RepositoryChoice[]
  repositoryId: string
  repositoriesError?: string
  repositoriesLoading?: boolean
  pendingSubmission?: { sessionId: SessionId; requestId: string }
  statusError?: string
  status?: { repository?: RepositorySnapshot; task_context?: Record<string, any>; running?: boolean; proposals?: { id: string; state: 'awaiting_confirmation' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; domain: string; action: string; input?: Record<string, any>; error?: string; continuation?: string }[] }
}

/** 浏览器只保留当前会话引用，任务与业务结果由原生 Session 和后端维护。 */
export function createAssistant(ctx: Pick<Context, 'sessions' | 'uiSession' | 'uiWorkspace'>, rpc: ClientConnectionRpc, getRoot: () => string | undefined, getLegacyRoots: () => string[] = () => []) {
  let snapshot: AssistantSnapshot = { busy: false, error: '', repositories: [], repositoryId: 'data' }
  let storage: Storage | undefined
  let storageUnavailable = false
  try { storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage } catch { storageUnavailable = true }
  let pending: PendingSubmission | undefined
  const pendingKey = () => `harness-platform:assistant-submission:v1:${getRoot() ?? ''}`
  function pendingForRoot() {
    const root = getRoot()
    if (pending?.root !== root) pending = undefined
    if (!pending && root && storage) {
      try {
        const saved = JSON.parse(storage.getItem(pendingKey()) ?? 'null')
        if (saved?.root === root && typeof saved.sessionId === 'string' && typeof saved.requestId === 'string' && saved.context && typeof saved.context === 'object') pending = saved
      } catch {}
    }
    return pending
  }
  function savePending(value: PendingSubmission) {
    pending = value
    publish({ pendingSubmission: { sessionId: value.sessionId, requestId: value.requestId } })
    // 浏览器投递前保存身份；存储不可写时保留本页草稿，不开始不可恢复的投递。
    try {
      if (storageUnavailable) throw new Error('storage unavailable')
      if (storage) { const text = JSON.stringify(value); storage.setItem(pendingKey(), text); if (storage.getItem(pendingKey()) !== text) throw new Error('storage readback mismatch') }
    } catch { throw new Error('无法保存任务恢复信息，请检查浏览器存储后重试。') }
  }
  function clearPending(value: PendingSubmission) {
    if (pending?.requestId !== value.requestId || getRoot() !== value.root) return
    if (storage) { try { if (JSON.parse(storage.getItem(pendingKey()) ?? 'null')?.requestId === value.requestId) storage.removeItem(pendingKey()) } catch {} }
    pending = undefined
    publish({ pendingSubmission: undefined })
  }
  let context: AssistantContext = { page: 'home' }
  let generation = 0
  let viewRevision = 0
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
    return Boolean(root && cwd && [root, ...getLegacyRoots(), ...snapshot.repositories.map(item => item.workspace), ...(snapshot.status?.repository?.workspace ? [snapshot.status.repository.workspace] : [])].includes(cwd))
  }
  let repositoryRequest = 0
  async function refreshRepositories() {
    const request = ++repositoryRequest, root = getRoot()
    publish({ repositoriesLoading: true, repositoriesError: '' })
    try {
      const response = await rpc.call(CHANNEL, 'assistant/repositories', {})
      if (disposed || request !== repositoryRequest || root !== getRoot()) return
      if (!response.ok) throw new Error(response.error.message)
      const value = response.value as { repositories: RepositoryChoice[] }
      if (!Array.isArray(value.repositories)) throw new Error('仓库目录返回无效')
      publish({ repositories: value.repositories, repositoriesLoading: false })
      restore()
    } catch (error) {
      if (!disposed && request === repositoryRequest && root === getRoot()) publish({ repositoriesLoading: false, repositoriesError: error instanceof Error ? error.message : '目标仓库读取失败' })
    }
  }
  let refreshing: Promise<void> | undefined
  let refreshPending = false
  const refreshOnce = async () => {
    const sessionId = snapshot.sessionId
    if (!sessionId || snapshot.platformContext === false || disposed) return
    const current = generation
    const request = ++refreshGeneration
    try {
      const response = await rpc.call(CHANNEL, 'assistant/status', { session_id: sessionId })
      if (disposed || generation !== current || request !== refreshGeneration) return
      if (!response.ok) throw new Error(response.error.message)
      publish({ status: response.value as AssistantSnapshot['status'], statusError: '' })
    } catch {
      if (!disposed && generation === current && request === refreshGeneration) publish({ statusError: '操作状态读取失败，当前显示上次结果；请重试核对。' })
    }
  }
  const refresh = (): Promise<void> => {
    refreshPending = true
    if (refreshing) return refreshing
    refreshing = (async () => {
      while (refreshPending && !disposed) { refreshPending = false; await refreshOnce() }
    })().finally(() => { refreshing = undefined })
    return refreshing
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
      publish({ sessionId, reference, platformContext: navigate || isProjectSession(sessionId), status: undefined, statusError: '', error: '' })
      void syncContext()
      await reference.ready
      if (current === generation && !disposed) { if (navigate) ctx.uiWorkspace.openSession(sessionId); await refresh() }
    }
    catch (error) {
      if (current === generation && !disposed) publish({ error: error instanceof Error ? error.message : '无法读取助手会话，请重试。' })
      if (navigate) throw error
    } finally { if (current === generation) selecting = false }
  }
  async function acceptedSubmission(value: PendingSubmission) {
    const response = await rpc.call(CHANNEL, 'assistant/status', { session_id: value.sessionId, request_id: value.requestId })
    if (!response.ok) throw new Error(response.error.message)
    return (response.value as { submission?: { request_id: string; state: string } }).submission?.state === 'accepted'
  }
  async function finishSubmission(value: PendingSubmission, current: number, view: number, navigate: boolean) {
    clearPending(value)
    if (!disposed && generation === current && viewRevision === view && getRoot() === value.root) {
      publish({ error: '' })
      await select(value.sessionId, navigate)
    }
  }
  async function recoverSubmission() {
    const value = pendingForRoot()
    if (!value || snapshot.busy || disposed) return
    const current = generation, view = viewRevision
    publish({ busy: true, error: '' })
    try {
      const accepted = await acceptedSubmission(value)
      if (disposed || generation !== current || getRoot() !== value.root) return
      if (accepted) await finishSubmission(value, current, view, true)
      else publish({ error: '原任务尚未确认受理。可继续核对，或重试同一次提交；不会另建会话。' })
    } catch (error) { if (!disposed && generation === current && getRoot() === value.root) publish({ error: `任务受理结果仍待核对：${error instanceof Error ? error.message : '连接暂不可用'}` }) }
    finally { if (!disposed) publish({ busy: false }) }
  }
  const restore = () => {
    if (disposed || selecting || snapshot.busy) return
    const saved = pendingForRoot()
    if (!saved && snapshot.pendingSubmission) publish({ pendingSubmission: undefined })
    if (saved && snapshot.pendingSubmission?.requestId !== saved.requestId) publish({ pendingSubmission: { sessionId: saved.sessionId, requestId: saved.requestId }, error: '有一项任务的受理结果待核对，请恢复原提交。' })
    const sessionId = ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
    if (!sessionId && snapshot.sessionId) {
      generation++
      snapshot.reference?.release()
      publish({ sessionId: undefined, reference: undefined, platformContext: false, status: undefined, statusError: '', error: '' })
    }
    if (sessionId && snapshot.sessionId !== sessionId) void select(sessionId, false)
    else if (sessionId && snapshot.platformContext !== isProjectSession(sessionId)) {
      publish({ platformContext: isProjectSession(sessionId), status: undefined, statusError: '', error: '' })
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
    refreshRepositories,
    selectRepository(id: string) {
      if (snapshot.busy) throw new Error('任务正在准备或核对，请等待当前回执。')
      if (id !== 'data' && !snapshot.repositories.some(item => item.id === id && item.available)) throw new Error('目标仓库不可用，请刷新核对。')
      publish({ repositoryId: id })
    },
    recoverSubmission,
    retrySubmission(): Promise<void> { const value = pendingForRoot(); return value ? this.create(value.task, value.context) : Promise.resolve() },
    startNewTask(nextContext: AssistantContext = context): Promise<void> { if (snapshot.busy) return Promise.reject(new Error('任务正在准备或核对，请等待当前回执。')); const value = pendingForRoot(); if (value) clearPending(value); return this.create(undefined, nextContext) },
    applySettlement(sessionId: SessionId, receipt: any) {
      if (disposed || snapshot.sessionId !== sessionId || !receipt || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(receipt.state)) return
      refreshGeneration++
      const id = receipt.id ?? receipt.proposal_id
      const { state, error, continuation } = receipt
      publish({ status: { ...snapshot.status, proposals: snapshot.status?.proposals?.map(proposal => proposal.id === id ? { ...proposal, state, error, continuation } : proposal) } })
    },
    restore,
    reveal() { if (snapshot.sessionId) ctx.uiWorkspace.openSession(snapshot.sessionId) },
    async create(task?: string, taskContext: AssistantContext = context): Promise<void> {
      if (snapshot.busy) throw new Error('任务正在准备或核对，请等待当前回执。')
      const current = generation, view = viewRevision
      let submission = pendingForRoot()
      let dispatched = false
      publish({ busy: true, error: '' })
      try {
        if (submission) {
          if (submission.task !== task || JSON.stringify(submission.context) !== JSON.stringify(taskContext)) throw new Error('上一项任务的受理结果待核对，请先恢复原提交。')
          if (await acceptedSubmission(submission)) { await finishSubmission(submission, current, view, true); return }
        }
        const sessionIdToResume = submission?.sessionId ?? (typeof taskContext.session_id === 'string' ? taskContext.session_id : undefined)
        const root = getRoot()
        if (!root) throw new Error('项目工作区尚未就绪，请稍后重试。')
        // 服务端统一准备管理工作区的空会话，目标仓库只记录业务来源；投递前保存原提交身份。
        let preparedSessionId = sessionIdToResume as SessionId | undefined
        if (!preparedSessionId) {
          const prepared = await rpc.call(CHANNEL, 'assistant/prepare-session', { repository_id: snapshot.repositoryId })
          if (!prepared.ok) throw new Error(prepared.error.message)
          preparedSessionId = (prepared.value as { session_id: SessionId }).session_id
          if (!preparedSessionId) throw new Error('目标仓库未返回会话标识')
          await ctx.sessions.refresh()
        }
        if (!submission) {
          submission = { root, sessionId: preparedSessionId, requestId: submissionRequestId(), ...(task !== undefined ? { task } : {}), context: structuredClone(taskContext) }
        }
        savePending(submission)
        const original = submission
        await ctx.sessions.using(preparedSessionId, { source: 'harnessAssistant' }, async () => {
          if (disposed || getRoot() !== original.root) return
          dispatched = true
          const response = await rpc.call(CHANNEL, 'assistant/session', {
            task: original.task, context: original.context, session_id: preparedSessionId, request_id: original.requestId,
          })
          if (!response.ok) throw new Error(response.error.message)
          const sessionId = (response.value as { session_id: SessionId }).session_id
          if (!sessionId) throw new Error('助手未返回会话标识，请重试。')
          if (sessionId !== preparedSessionId) throw new Error('助手返回的会话与已建立的会话不一致，请重试。')
          await finishSubmission(original, current, view, true)
        })
      } catch (error) {
        if (submission && dispatched) {
          try { if (await acceptedSubmission(submission)) { await finishSubmission(submission, current, view, true); return } } catch {}
        }
        if (!disposed) publish({ error: error instanceof Error ? error.message : '无法创建助手会话。' })
        throw error
      } finally { if (!disposed) publish({ busy: false }) }
    },
    updateContext(next: AssistantContext) {
      if (JSON.stringify(context) === JSON.stringify(next)) return
      context = next
      viewRevision++
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

/** 仅提供嵌入容器，正文、视图与输入区均交给原生 Factory。 */
export function AssistantConversation({ useSession, useConversation, renderFactorySlot }: PropsRuntime<'harness.assistant.conversation'> & PropsRenderFactories) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = Boolean(session && (session.running || !session.blank || session.promptAttempted)) || Boolean(conversation?.activeTargets.size)
  const hero = !active
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: hero ? 'hero' : 'active', hero })
}
