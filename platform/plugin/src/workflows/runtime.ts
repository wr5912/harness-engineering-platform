import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { observeLlm, type ModelAttempt } from '../evaluation/model-attempts.ts'
import { compileSequence } from './graph.ts'
import { registerFixedCompositionTools, withFixedCompositionExecution, type FixedCompositionBinding } from './fixed-composition.ts'
import { runtimeModule, runtimeRequire } from '../../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
import { CODE_ONLY_MODEL, CODE_ONLY_PROVIDER, HYBRID_WORKFLOW_MODEL, HYBRID_WORKFLOW_PROVIDER } from './code-only-route.ts'
import { matchesWorkflowModelBinding, validateWorkflowModelRoles, type WorkflowModelRoles } from './model-roles.ts'

export { Annotation, END, START, StateGraph }
export { fixedCompositionToolName, type FixedCompositionBinding } from './fixed-composition.ts'
export { type WorkflowModelBinding, type WorkflowModelRoles } from './model-roles.ts'
declare const __WORKFLOW_BUILD_DIGEST__: string
declare const __WORKFLOW_SOURCE_DIGEST__: string
// 在模块装载时固定，后续宿主重建同路径不改写本进程实际装载的身份。
const loadedEsmSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
// 与真实工具执行器使用同一无损 JSON 校验，不用 stringify 静默删除业务字段。
const toolsManifest = '/opt/dsh/packages/core/tools/package.json'
const { snapshotJsonValue } = await runtimeModule('@deepseek-ai/dsh-util-values', existsSync(toolsManifest) ? toolsManifest
  : runtimeRequire('@deepseek-ai/dsh-api-session-controller').resolve('@deepseek-ai/dsh-api-session-controller'))
const nativeLlm = await runtimeModule('@deepseek-ai/dsh-llm', existsSync(toolsManifest) ? toolsManifest
  : runtimeRequire('@deepseek-ai/dsh-api-session-controller').resolve('@deepseek-ai/dsh-api-session-controller'))
/** 原生 Provider 适配器复用当前 Runtime 的归属头和结构化错误。 */
export const LlmError: new (message: string, code: string, options?: { status?: number; requestId?: string; cause?: unknown }) => Error & { readonly failure: Record<string, unknown> } = nativeLlm.LlmError
export const attributionHeaders: () => Record<string, string> = nativeLlm.attributionHeaders

export interface WorkflowContext {
  input: Record<string, any>
  signal: AbortSignal
  executionId: string
  trace: Record<string, any>[]
  callTool(name: string, args: Record<string, any>): Promise<any>
  infer(config: Record<string, any>, input: { system?: string; messages: any[] }): Promise<{ content: string }>
  decide(name: string, args: Record<string, any>): Promise<Record<string, any>>
}
export interface WorkflowDefinition {
  id: string
  toolName: string
  description: string
  inputSchema: Record<string, any>
  fixedCompositions?: Record<string, FixedCompositionBinding>
  run(context: WorkflowContext): Promise<any>
}
export function defineWorkflow<T extends WorkflowDefinition>(definition: T): T { return definition }

export interface WorkflowToolOptions {
  executionMode?: 'code-only' | 'hybrid'
  modelRoles?: WorkflowModelRoles
}
class WorkflowModelUnavailableError extends Error {}

/** 顺序节点共用 LangGraph；业务条件和参数来源留在业务源码。 */
export async function runWorkflow(context: WorkflowContext, steps: { id: string; run(values: Record<string, any>, context: WorkflowContext): Promise<any> }[]) {
  if (!steps.length || new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('工作流节点不能为空或重名')
  const State = Annotation.Root({ values: Annotation<Record<string, any>>() })
  const graph = compileSequence(State, steps.map(step => ({ id: step.id, run: async (state: typeof State.State) => {
    context.signal.throwIfAborted()
    const started = Date.now()
    try {
      const result = await step.run(state.values, context)
      context.trace.push({ node: step.id, status: 'completed', elapsed_ms: Date.now() - started })
      return { values: { ...state.values, [step.id]: result } }
    } catch (error) {
      context.trace.push({ node: step.id, status: context.signal.aborted ? 'cancelled' : 'failed', elapsed_ms: Date.now() - started })
      throw error
    }
  } })))
  const result = await graph.invoke({ values: {} }, { signal: context.signal })
  return result.values as Record<string, any>
}

/** 通过原生工具管线执行子调用，保留调用身份、取消和真实回执。 */
export function registerWorkflowTool(ctx: any, definition: WorkflowDefinition, options: WorkflowToolOptions = {}) {
  if (options.executionMode === 'hybrid' && !validateWorkflowModelRoles(options.modelRoles)) throw new Error('混合工作流必须固定语言与决策模型身份')
  const modelRoles = options.modelRoles ? structuredClone(options.modelRoles) : undefined
  const aliases = registerFixedCompositionTools(ctx, definition.fixedCompositions ?? {})
  return ctx.tools.register({
    name: definition.toolName, description: definition.description, parameters: definition.inputSchema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => ({ graph_execution: value.graph_execution }),
    },
    isConcurrencySafe: () => false,
    async execute(input: Record<string, any>, exec: any) {
      const executionId = `workflow-${randomUUID()}`, trace: Record<string, any>[] = [], attempts: ModelAttempt[] = []
      const identity = { execution_id: executionId, role: 'target' as const,
        ...(exec.agent?.session?.id ? { session_id: exec.agent.session.id } : {}), ...(exec.callId ? { tool_call_id: exec.callId } : {}),
        ...(exec.parent_run_id ? { parent_run_id: exec.parent_run_id } : {}), ...(exec.case_id ? { case_id: exec.case_id } : {}) }
      let observed: ReturnType<typeof observeLlm> | undefined
      function modelObserver() {
        if (observed) return observed
        let native: any
        try { native = ctx.llm } catch { /* Cordis 未声明注入时同样按模型服务不可用报告。 */ }
        if (!native || typeof native.prepareCall !== 'function') throw new WorkflowModelUnavailableError('工作流模型服务未装载；使用 infer 的插件需要声明 llm 注入')
        const llm = options.executionMode === 'hybrid' ? { async prepareCall(...args: any[]) {
          const prepared = await native.prepareCall(...args)
          if (!matchesWorkflowModelBinding({ ...prepared.config, reasoning_effort: prepared.config?.reasoningEffort }, modelRoles!.language)) throw new Error('装配后的语言模型不符合混合工作流角色绑定')
          return prepared
        } } : native
        observed = observeLlm(llm, { ...identity,
          ...(options.executionMode === 'hybrid' ? { model_role: 'language' as const, ...Object.fromEntries(Object.entries(modelRoles!.language).filter(([key]) => key.endsWith('_sha256'))) } : {}) }, (event: ModelAttempt) => {
          attempts.push(Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as ModelAttempt)
        })
        return observed
      }
      async function invokeTool(name: string, args: Record<string, any>) {
        exec.signal.throwIfAborted()
        const callId = `${exec.callId}:workflow:${trace.length}:${randomUUID()}`
        const started = Date.now()
        const result = await withFixedCompositionExecution(identity, () => ctx.tools.execute({ name: aliases.get(name) ?? name,
          arguments: args, callId, rootCallId: exec.rootCallId ?? exec.callId, parent: exec.token, agent: exec.agent, signal: exec.signal }))
        const failed = result.isError || result.value?.isError === true
        trace.push({ node: name, call_id: callId, arguments: args, status: failed ? 'failed' : 'completed',
          elapsed_ms: Date.now() - started, result: result.isError ? {
            ...(result.error !== undefined ? { error: result.error } : {}), ...(result.content !== undefined ? { content: result.content } : {}),
          } : result.value,
          ...(result.meta ? { meta: result.meta } : {}) })
        if (result.additionalContexts?.length && exec.deferContext) for (const value of result.additionalContexts) exec.deferContext(value)
        return { failed, value: result.value }
      }
      const context: WorkflowContext = {
        input, signal: exec.signal, executionId, trace,
        async callTool(name, args) {
          const result = await invokeTool(name, args)
          if (result.failed) throw new Error(`工作流工具失败：${name}`)
          return result.value
        },
        async infer(config, payload) {
          if (options.executionMode === 'code-only') throw new Error('纯代码工作流禁止模型调用')
          if (options.executionMode === 'hybrid' && !matchesWorkflowModelBinding({ ...config, reasoning_effort: config.reasoningEffort }, modelRoles!.language)) throw new Error('语言推理路由不符合混合工作流角色绑定')
          const observed = modelObserver()
          const prepared = await observed.prepareCall(config, exec.signal)
          let content = '', completed = false, failure: Error | undefined
          for await (const chunk of prepared.stream({ ...prepared.config, ...(payload.system === undefined ? {} : { system: payload.system }), messages: payload.messages,
            sessionId: identity.session_id, signal: exec.signal })) {
            if (chunk.type === 'text-delta') content += chunk.text
            if (chunk.type === 'finish') {
              if (chunk.reason?.kind === 'stop') completed = true
              else {
                const detail = chunk.reason?.failure
                const error = detail ? new LlmError(detail.message, detail.code, { status: detail.status, requestId: detail.requestId })
                  : new Error('工作流模型响应未完成')
                if (chunk.reason?.kind !== 'error' || !detail) throw error
                // 先让观察器结算原生失败终态及用量，再将同一失败交给业务调用方。
                failure = error
              }
            }
          }
          if (failure) throw failure
          if (!completed) throw new Error('工作流模型响应未完成')
          return { content }
        },
        async decide(name, args) {
          if (options.executionMode !== 'hybrid') throw new Error('类型化决策仅适用于混合工作流')
          if (Object.hasOwn(args, 'model_execution')) throw new Error('model_execution 由运行库提供')
          const binding = modelRoles!.decision
          const decisionCallId = `decision-${randomUUID()}`
          const invocation = { ...identity, decision_call_id: decisionCallId }
          // 在无法获得服务回执时保留未知请求，不能把传输失败误记为零调用。
          const fallback = { ...identity, attempt_id: decisionCallId, model_role: 'decision' as const, kind: 'typed_decision' as const, ...binding }
          attempts.push({ ...fallback, status: 'preparing', time: Date.now() }, { ...fallback, status: 'started', time: Date.now() })
          try {
            const result = await invokeTool(name, { ...args, model_execution: invocation })
            const value = result.value
            const received = value?.model_execution
            if (!received || Object.keys(received).length !== Object.keys(invocation).length
              || Object.entries(invocation).some(([key, item]) => received[key] !== item)
              || !Array.isArray(value.model_requests) || !value.model_requests.length) throw new Error('类型化决策缺少模型执行回执')
            const requests = new Map<string, any>()
            for (const request of value.model_requests) {
              if (!request || typeof request.request_id !== 'string' || !request.request_id.trim() || !['completed', 'failed', 'cancelled'].includes(request.status)
                || request.model_invocation !== undefined && typeof request.model_invocation !== 'boolean' || !matchesWorkflowModelBinding(request, binding)
                || request.status === 'completed' && request.model_invocation !== true
                || request.model_invocation === false && request.usage !== undefined) throw new Error('类型化决策模型回执与绑定不一致')
              if (requests.has(request.request_id) && JSON.stringify(requests.get(request.request_id)) !== JSON.stringify(request)) throw new Error('模型请求身份存在冲突')
              if (requests.has(request.request_id)) continue
              requests.set(request.request_id, request)
              const attempt = { ...identity, model_role: 'decision' as const, kind: 'typed_decision' as const, ...binding,
                attempt_id: `${executionId}:${request.request_id}`, ...(request.model_invocation !== undefined ? { model_invocation: request.model_invocation } : {}), time: Date.now() }
              if (request.model_invocation) attempts.push({ ...attempt, status: 'started' })
              const usage = request.usage && Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
                .filter(key => typeof request.usage[key] === 'number').map(key => [key, request.usage[key]]))
              attempts.push({ ...attempt, status: request.status, ...(usage ? { usage } : {}) })
            }
            attempts.splice(0, attempts.length, ...attempts.filter(attempt => attempt.attempt_id !== decisionCallId))
            if (result.failed || value.ok === false || [...requests.values()].at(-1)?.status !== 'completed'
              || !value.typed_decision || typeof value.typed_decision !== 'object' || Array.isArray(value.typed_decision)
              || !Object.keys(value.typed_decision).length || snapshotJsonValue(value.typed_decision) === undefined) throw new Error('类型化决策未完成')
            return value.typed_decision
          } catch (error) {
            trace.push({ node: `${name}:typed_decision`, status: exec.signal.aborted ? 'cancelled' : 'failed', error_code: 'DECISION_NOT_COMPLETED' })
            if (attempts.some(attempt => attempt.attempt_id === decisionCallId)) attempts.push({ ...fallback, status: exec.signal.aborted ? 'cancelled' : 'failed', time: Date.now(), error_type: 'DecisionReceiptUnavailable' })
            throw error
          }
        },
      }
      let result: any, failure: string | undefined, errorCode: string | undefined, modelFailure: Record<string, unknown> | undefined
      try {
        result = snapshotJsonValue(await definition.run(context))
        if (result === undefined) {
          failure = '工作流返回值不是无损 JSON；请修复业务源码中的 undefined 或其他非 JSON 值'
          errorCode = 'WORKFLOW_INVALID_RESULT'
        }
      } catch (error) {
        failure = exec.signal.aborted ? '工作流已取消' : '工作流执行失败，请查看节点回执'
        if (!exec.signal.aborted && error instanceof WorkflowModelUnavailableError) {
          failure = error.message; errorCode = 'WORKFLOW_MODEL_UNAVAILABLE'
        }
        if (!exec.signal.aborted && error instanceof LlmError) {
          const detail = error.failure
          modelFailure = { code: detail.code, message: detail.message, ...(detail.status === undefined ? {} : { status: detail.status }),
            ...(detail.requestId === undefined ? {} : { requestId: detail.requestId }) }
        }
      }
      const graph_execution = { ...identity, workflow_id: definition.id, complete: true,
        ...(options.executionMode ? { execution_mode: options.executionMode } : {}),
        ...(typeof __WORKFLOW_BUILD_DIGEST__ === 'string' ? { build_digest: __WORKFLOW_BUILD_DIGEST__, source_digest: __WORKFLOW_SOURCE_DIGEST__ } : {}),
        esm_sha256: loadedEsmSha256,
        status: failure ? exec.signal.aborted ? 'cancelled' : 'failed' : 'completed', ...(modelFailure ? { failure: modelFailure } : {}), trace, model_attempts: attempts }
      // 失败也返回完整结构化证据；上层必须检查 ok，不能用工具文字流畅代替成功。
      return { ok: !failure, ...(failure ? { error: failure, ...(errorCode ? { error_code: errorCode } : {}) } : { result }), graph_execution }
    },
  })
}

export interface CodeOnlyWorkflowAgent {
  presetId: string
  workflow: WorkflowDefinition
  renderResult?(result: any): string
}

export interface HybridWorkflowAgent extends CodeOnlyWorkflowAgent { modelRoles: WorkflowModelRoles }

interface CodeOnlyTurn {
  turn: number
  request: string
  callId: string
  issued: boolean
  replied: boolean
  notices?: WorkflowNotice[]
  noticeOnly?: boolean
  pending?: { kind: 'tool' } | { kind: 'text'; text: string }
}

interface WorkflowNotice { id: string; senderSessionId: string; text: string }

const textContent = (message: any): string => (message?.content ?? [])
  .filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')

/** 用本地原生适配器完成一个回合；业务规则、分支和回复内容仍由 LangGraph 提供。 */
export function registerCodeOnlyWorkflowAgent(ctx: any, options: CodeOnlyWorkflowAgent) {
  return registerWorkflowAgent(ctx, options, 'code-only')
}

/** 每轮由图控制，只有图中显式 infer 才调用模型，不请求外层模型选择工具。 */
export function registerHybridWorkflowAgent(ctx: any, options: HybridWorkflowAgent) {
  return registerWorkflowAgent(ctx, options, 'hybrid')
}

function registerWorkflowAgent(ctx: any, options: CodeOnlyWorkflowAgent | HybridWorkflowAgent, mode: 'code-only' | 'hybrid') {
  const codeOnly = mode === 'code-only', label = codeOnly ? '纯代码工作流' : '混合工作流'
  const providerId = codeOnly ? CODE_ONLY_PROVIDER : HYBRID_WORKFLOW_PROVIDER
  const modelId = codeOnly ? CODE_ONLY_MODEL : HYBRID_WORKFLOW_MODEL
  if (!options.presetId.trim()) throw new Error(`${label}必须绑定 Preset`)
  const { workflow } = options
  registerWorkflowTool(ctx, workflow, { executionMode: mode, ...('modelRoles' in options ? { modelRoles: options.modelRoles } : {}) })
  const turns = new Map<string, CodeOnlyTurn>()
  const sessionId = (agent: any): string => agent.session.id
  const isSubject = (agent: any): boolean => agent?.session?.header?.agentPreset === options.presetId
  const route = { provider: providerId, model: modelId, reasoningEffort: 'off' }
  const unknown = '工作流执行结果未知，已停止；请核对本轮工具回执后继续。'

  function notice(message: any): WorkflowNotice | undefined {
    if (message?.source?.kind !== 'subagent-settled' || message.source.form !== 'notice'
      || typeof message.id !== 'string' || !message.id
      || typeof message.source.senderSessionId !== 'string' || !message.source.senderSessionId
      || !Array.isArray(message.content) || !message.content.length
      || message.content.some((block: any) => block?.type !== 'text' || typeof block.text !== 'string')) return undefined
    const text = textContent(message)
    return text.trim() ? { id: message.id, senderSessionId: message.source.senderSessionId, text } : undefined
  }

  const noticeText = (value: WorkflowNotice): string => `### 子任务回执（${value.senderSessionId}）\n\n${value.text}`
  const renderNotices = (values: WorkflowNotice[] = []): string => values.map(noticeText).join('\n\n')

  function currentNotices(agent: any, turn: number, messages: any[]): { notices: WorkflowNotice[]; eligible: boolean } {
    const events = agent.session.snapshotEvents()
    const start = events.findLastIndex((event: any) => event.type === 'turn/start' && event.data.turn === turn)
    const previous = start < 0 ? events : events.slice(0, start)
    const old = new Set(previous.filter((event: any) => event.type === 'user/message').map((event: any) => notice(event.data)?.id).filter(Boolean))
    const current = start < 0 ? [] : events.slice(start)
    const ended = current.some((event: any) => event.type === 'turn/end' && event.data.turn === turn)
    const replies: Array<{ index: number; text: string }> = current.flatMap((event: any, index: number) => event.type === 'assistant/message' && event.data.turn === turn
      && event.data.message?.source?.provider === providerId && event.data.message?.source?.model === modelId
      ? [{ index, text: textContent(event.data.message) }] : [])
    const state = turns.get(sessionId(agent))
    const delivered = state?.turn === turn && state.replied ? new Set(state.notices?.map(value => value.id)) : new Set<string>()
    const values = new Map<string, WorkflowNotice>()
    for (const message of messages) {
      const value = notice(message)
      if (value && !old.has(value.id)) values.set(value.id, value)
    }
    return { eligible: !ended && values.size > 0,
      notices: ended ? [] : [...values.values()].filter(value => {
        // 同一子会话可以再次给出相同正文，只有本条消息入日志之后的回复才证明已交付。
        const input = current.findIndex((event: any) => event.type === 'user/message' && event.data.id === value.id)
        return !delivered.has(value.id) && !(input >= 0 && replies.some(reply => reply.index > input && reply.text.includes(noticeText(value))))
      }) }
  }

  ctx.on('agent/pre-step', async ({ agent, turn }: any, next: () => Promise<any>) => {
    const decision = await next()
    if (!isSubject(agent) || decision.kind !== 'enter') return decision
    const messages = decision.messages.filter((message: any) => message.source?.kind === 'user')
    const previous = turns.get(sessionId(agent))
    const current = decision.messages.some((message: any) => notice(message))
      ? currentNotices(agent, turn, decision.messages) : { notices: [], eligible: false }
    const notices = [...new Map([...(previous && previous.turn === turn && !previous.replied ? previous.notices ?? [] : []),
      ...current.notices].map(value => [value.id, value])).values()]
    if (messages.length) turns.set(sessionId(agent), {
      turn, request: messages.map(textContent).join('\n'), callId: `${mode}-${randomUUID()}`, issued: false, replied: false,
      notices,
    })
    else if (current.notices.length) {
      if (previous && previous.turn === turn && !previous.replied && (previous.request || previous.callId || previous.noticeOnly)) previous.notices = notices
      else turns.set(sessionId(agent), { turn, request: '', callId: '', issued: true, replied: false, notices, noticeOnly: true })
    }
    return decision
  })

  function restoredTurn(agent: any, turn: number): CodeOnlyTurn | undefined {
    const events = agent.session.snapshotEvents()
    const start = events.findLastIndex((event: any) => event.type === 'turn/start' && event.data.turn === turn)
    if (start < 0) return undefined
    const current = events.slice(start)
    const human = current.findLastIndex((event: any) => event.type === 'user/message' && event.data.source?.kind === 'user')
    const boundary = current.findLastIndex((event: any, index: number) => index < human
      && ['step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message'].includes(event.type))
    const batch = current.slice(boundary + 1)
    const call = batch.findLast((event: any) => event.type === 'tool/call' && event.data.turn === turn && event.data.name === workflow.toolName)
    const request = batch.filter((event: any) => event.type === 'user/message' && event.data.source?.kind === 'user').map((event: any) => textContent(event.data)).join('\n')
    const messages = current.filter((event: any) => event.type === 'user/message').map((event: any) => event.data)
    const { notices, eligible } = messages.some((message: any) => notice(message))
      ? currentNotices(agent, turn, messages) : { notices: [], eligible: false }
    const reply = current.findLastIndex((event: any) => event.type === 'assistant/message' && event.data.turn === turn
      && event.data.message?.source?.provider === providerId && event.data.message?.source?.model === modelId
      && textContent(event.data.message).trim())
    if (eligible && human <= reply) return { turn, request: '', callId: '', issued: true, replied: !notices.length, notices, noticeOnly: true }
    if (!request && !call) return eligible ? { turn, request: '', callId: '', issued: true, replied: !notices.length, notices, noticeOnly: true } : undefined
    return { turn, request, callId: call?.data.callId ?? `${mode}-${randomUUID()}`, issued: Boolean(call), replied: false, notices }
  }

  function resultText(agent: any, state: CodeOnlyTurn): string {
    const receipt = agent.session.snapshotEvents().findLast((event: any) => event.type === 'tool/result'
      && event.data.turn === state.turn && event.data.message?.toolCallId === state.callId
      && event.data.message?.source?.callId === state.callId)
    if (!receipt) return unknown
    if (receipt.data.message.isError || receipt.data.error) return '工作流工具执行失败，已停止；请查看本轮工具回执。'
    try {
      const value = JSON.parse(textContent(receipt.data.message)), graph = value.graph_execution
      if (graph?.session_id !== sessionId(agent) || graph?.tool_call_id !== state.callId || graph.execution_mode !== mode
        || graph.complete !== true || graph.status !== 'completed' || !Array.isArray(graph.model_attempts)
        || codeOnly && graph.model_attempts.length) return `工作流未完成或执行证据不符合${label}要求，已停止；请查看本轮图回执。`
      if (value.ok !== true) return '工作流执行失败，已停止；请查看本轮图回执。'
      const text = options.renderResult ? options.renderResult(value.result) : value.result?.reply
      return typeof text === 'string' && text.trim() ? text : '工作流未提供有效回复，已停止；请查看本轮图回执。'
    } catch { return '工作流回执无法解析，已停止；请查看本轮工具回执。' }
  }

  ctx.on('agent/request', async ({ agent, turn, signal }: any, next: () => Promise<any>) => {
    if (!isSubject(agent)) return next()
    signal.throwIfAborted()
    const id = sessionId(agent)
    let state = turns.get(id)
    if (!state || state.turn !== turn) {
      state = restoredTurn(agent, turn)
      if (state) turns.set(id, state)
    }
    if (!state) {
      state = { turn, request: '', callId: '', issued: true, replied: false, pending: { kind: 'text', text: unknown } }
      turns.set(id, state)
    } else if (state.noticeOnly) state.pending = { kind: 'text', text: state.replied ? '本轮子任务回执已投递。' : renderNotices(state.notices) }
    else state.pending = state.issued ? { kind: 'text', text: state.replied ? '本轮工作流已结束，请提交新的任务。'
      : [resultText(agent, state), renderNotices(state.notices)].filter(Boolean).join('\n\n') } : { kind: 'tool' }
    return route
  })

  ctx.llm.registerAdapter([providerId], {
    providerInfo: (provider: string) => ({ id: provider, name: `${label}（${codeOnly ? '本地执行' : '本地派发'}）` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    async listModels() { return [await this.resolveModel(providerId, modelId)] },
    resolveModel: async (provider: string, model: string) => {
      if (provider !== providerId || model !== modelId) throw new Error(`${label}路由无效`)
      return { provider, id: model, name: label, reasoning: { efforts: [{ id: 'off', name: '关闭' }] } }
    },
    async prepareCall(provider: string, model: string) {
      return { model: await this.resolveModel(provider, model), stream: (request: any) => this.stream(request) }
    },
    async *stream(request: any) {
      request.signal?.throwIfAborted()
      const state = turns.get(request.sessionId), pending = state?.pending
      if (!state || !pending) throw new Error(`${label}缺少本轮请求`)
      delete state.pending
      if (pending.kind === 'tool') {
        // 调用一旦发出就不重放；取消或未知回执都由后续本地回复说明。
        if (state.issued) throw new Error(`${label}调用已发出`)
        state.issued = true
        const args = JSON.stringify({ request: state.request })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: state.callId, name: workflow.toolName, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: state.callId, name: workflow.toolName, arguments: args } }
        request.signal?.throwIfAborted()
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        state.replied = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: pending.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: pending.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  })
  ctx.sessionTitle.register({
    id: codeOnly ? 'harness-code-only-title' : 'harness-hybrid-title', automatic: 'first-prompt',
    async generate(request: any) {
      request.signal.throwIfAborted()
      const first = request.messages[0]
      if (!first) throw new Error(`${label}标题缺少用户输入`)
      return { title: [...first.text.replace(/\s+/g, ' ').trim()].slice(0, 32).join(''), messageSeqs: [first.seq] }
    },
  })
  ctx.on('session/event', (session: any, event: any) => {
    if (event.type === 'turn/end' && turns.get(session.id)?.turn === event.data.turn) turns.delete(session.id)
  })
  ctx.on('agent/disposed', ({ agent }: any) => { if (isSubject(agent)) turns.delete(sessionId(agent)) })
}
