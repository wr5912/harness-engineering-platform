import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { listRunFiles, readRunEvidenceFile, redactRunText, RunFileError } from '../agents/run-files.ts'
import { decisionSourceGroup } from './decision-source-group.ts'

type JsonMap = Record<string, any>
export type TraceRole = 'target' | 'judge' | 'analysis' | 'unknown'
export const DECISION_TRACE_DECODER_VERSION = 'decision-trace-lineage-v1'
export interface TraceRef {
  path: string
  line: number
  session_log: string | null
  event_id: string | null
  seq: number | null
  source_sha256: string
  line_sha256: string
}
export interface TraceEvent {
  ref: TraceRef
  type: string
  role: TraceRole
  collection_status?: TraceSource['collection_status']
  status: 'valid' | 'unknown' | 'malformed' | 'oversized'
  event?: JsonMap
  warning?: string
  lineage?: TraceLineage
}
export interface TraceLineage {
  kind: 'delegated_task'
  root_session_id: string; parent_session_id: string; actor_session_id: string
  root_session_log: string; parent_session_log: string; session_log: string
  delegation: { tool_name: string; call_id: string; call_ref: TraceRef; result_ref: TraceRef; catalog_ref: TraceRef; descriptor_ref: TraceRef; header_ref: TraceRef; task_ref: TraceRef; task_content_sha256: string }
}
export interface TraceSource {
  path: string
  size: number
  role: TraceRole
  role_basis: string[]
  collection_status: 'available' | 'unavailable' | 'unknown'
  warnings: string[]
  root_identity?: { session_id: string; session_log: string; agent_preset?: string }
}
export interface TraceSourceBundle {
  schema_version: 1
  sha256: string
  files: { path: string; source_sha256: string | null }[]
  issues: string[]
}
export interface TraceMessage {
  role: string
  content: unknown
  ref: TraceRef
  source?: JsonMap
  tool_call_id?: string
  tool_calls?: unknown
  name?: string
}
export interface DecisionSlice {
  id: string
  kind: 'tool_call' | 'assistant_response'
  role: TraceRole
  anchor: TraceRef
  request_ref: TraceRef | null
  state: { messages: TraceMessage[]; available_tools: unknown; route: unknown }
  context_refs: TraceRef[]
  context_mode: 'actual_request' | 'reconstructed' | 'unavailable'
  observed_action: { name: string; arguments?: unknown; content?: unknown; call_id?: string }
  outcome_refs: TraceRef[]
  outcome: { status: 'observed' | 'missing'; refs: TraceRef[]; result?: unknown }
  eligible: boolean
  limitations: string[]
  lineage?: TraceLineage
  source_group_id?: string
}
export interface RunTraceInput {
  run_id: string
  path?: string
  cursor?: number
  limit?: number
  source_sha256?: string
  session_log?: string
}

const MAX_LINE_BYTES = 128 * 1024
const PAGE_BYTES = 256 * 1024
const KNOWN_TYPES = new Set(['session', 'session/created', 'user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'request/context', 'request/body', 'request/messages', 'request/start', 'request/response', 'agent/inbox/spliced', 'session/title', 'session/title-llm-request', 'permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/catalog', 'subagent/descriptor', 'agent-preset/selected'])
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const map = (value: unknown): JsonMap | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : null
const asString = (value: unknown): string | null => typeof value === 'string' ? value : null
const redact = (value: unknown): any => JSON.parse(redactRunText(JSON.stringify(value)))
const tracePath = (path: string) => /(?:^|\/)(?:trace|judge-trace)\.jsonl$/.test(path)

async function optionalJson(root: string, runId: string, path: string, signal?: AbortSignal): Promise<JsonMap | null> {
  try { return map(JSON.parse((await readRunEvidenceFile(root, runId, path, signal, 2 * 1024 * 1024)).data.toString('utf8'))) }
  catch (error) {
    if (error instanceof RunFileError && error.code === 'aborted') throw error
    return null
  }
}

/** 角色只依据冻结输入和实际采集记录识别，不把所有非 judge 文件猜作目标智能体。 */
export async function listRunTraceSources(root: string, runId: string, signal?: AbortSignal): Promise<TraceSource[]> {
  const files = await listRunFiles(root, runId, signal)
  const selected = files.files.filter(file => tracePath(file.path))
  if (!selected.length) return []
  const marker = `/runs/${runId}`
  const base = selected[0]!.path.slice(0, selected[0]!.path.indexOf(marker) + marker.length)
  const inputs = await optionalJson(root, runId, `${base}/inputs.lock.json`, signal)
  return Promise.all(selected.map(async file => {
    const directory = posix.dirname(file.path)
    const checks = await optionalJson(root, runId, `${directory}/checks.json`, signal)
    const judge = file.path.endsWith('/judge-trace.jsonl') ? await optionalJson(root, runId, `${directory}/judge.json`, signal) : null
    return classifySource(file, base, inputs, checks, judge)
  }))
}

function classifySource(file: { path: string; size: number }, base: string, inputs: JsonMap | null, checks: JsonMap | null, judge: JsonMap | null): TraceSource {
  const caseIds = new Set((Array.isArray(inputs?.evaluation_cases) ? inputs.evaluation_cases : []).map((item: any) => item?.case_id).filter((id: any) => typeof id === 'string'))
  const local = file.path.slice(base.length + 1)
  let role: TraceRole = 'unknown'
  const role_basis: string[] = []
  if (file.path.endsWith('/judge-trace.jsonl') && judge) { role = 'judge'; role_basis.push('judge-trace.jsonl 与同目录 judge.json 评审采集记录') }
  else if (!file.path.endsWith('/judge-trace.jsonl') && checks?.operation === 'review' && local.startsWith('evidence/analysis/')) { role = 'analysis'; role_basis.push('analysis 目录及 checks.operation=review') }
  else if (!file.path.endsWith('/judge-trace.jsonl') && /^evidence\/[^/]+\/trace\.jsonl$/.test(local) && caseIds.has(local.split('/')[1])) { role = 'target'; role_basis.push('inputs.lock.json 冻结 Case 对应的原始执行轨迹') }
  const unavailable = checks?.trace_available === false || file.size === 0
  const collection_status = unavailable ? 'unavailable' : checks?.trace_available === true ? 'available' : 'unknown'
  const warnings = [...(role === 'unknown' ? ['缺少足够的轨迹角色依据，不推定为目标智能体。'] : []), ...(unavailable ? ['该轨迹为空或采集记录标明未取得轨迹。'] : []), ...(collection_status === 'unknown' ? ['采集记录未明确声明 trace_available，轨迹完整性未知。'] : [])]
  const root_identity = role === 'target' && typeof checks?.session_id === 'string' && checks.session_id
    && typeof checks.root_session_log === 'string' && checks.root_session_log && !/[\\/]/.test(checks.root_session_log)
    ? { session_id: checks.session_id, session_log: checks.root_session_log,
      ...(typeof checks.session_preset === 'string' ? { agent_preset: checks.session_preset } : {}) } : undefined
  return { path: file.path, size: file.size, role, role_basis, collection_status, warnings, ...(root_identity ? { root_identity } : {}) } as TraceSource
}

function taskText(message: any): string | null {
  if (typeof message?.content === 'string') return message.content
  const content = message?.content
  return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string' ? content[0].text : null
}

/** 只提升采集根身份、原生父子header和实际委派回执相互吻合的执行子树。 */
function assignTargetLineage(events: TraceEvent[], source: Pick<TraceSource, 'path' | 'role'> & Partial<TraceSource>) {
  const rootLog = source.root_identity?.session_log ?? events.find(row => row.ref.session_log && !/[\\/]/.test(row.ref.session_log))?.ref.session_log
  events = events.map(row => row.ref.session_log && row.ref.session_log !== rootLog && row.role !== 'unknown'
    ? { ...row, role: 'unknown' as const, warning: '子会话或缺少 Session 日志定位，不能继承根轨迹的智能体角色。' } : row)
  if (source.role !== 'target' || source.collection_status !== 'available' || !source.root_identity) return events
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events) if (event.ref.session_log) {
    const rows = groups.get(event.ref.session_log) ?? []; rows.push(event); groups.set(event.ref.session_log, rows)
  }
  const headers = [...groups].flatMap(([log, rows]) => {
    const values = rows.filter(row => row.type === 'session' && row.status === 'valid')
    return values.length === 1 && typeof values[0]!.event?.id === 'string' ? [{ log, rows, row: values[0]!, header: values[0]!.event! }] : []
  })
  const unique = (id: string) => headers.filter(entry => entry.header.id === id).length === 1
  const root = headers.find(entry => entry.log === source.root_identity!.session_log && entry.header.id === source.root_identity!.session_id)
  if (!root || !unique(root.header.id) || (root.header.delegationDepth ?? 0) !== 0
    || source.root_identity.agent_preset !== undefined && root.header.agentPreset !== source.root_identity.agent_preset) {
    return events.map(row => row.ref.session_log === rootLog ? { ...row, role: 'unknown' as const, warning: '采集记录的根 Session 与原始 header 不一致，不能确认目标执行身份。' } : row)
  }
  const trusted = new Map<string, typeof root>([[root.header.id, root]])
  const lineages = new Map<string, TraceLineage>()
  let changed = true
  while (changed) {
    changed = false
    for (const child of headers) {
      if (trusted.has(child.header.id) || !unique(child.header.id) || child.header.origin !== 'subagent'
        || child.header.isSeeded !== false || typeof child.header.agentPreset !== 'string') continue
      const parent = trusted.get(child.header.parentSession)
      if (!parent || !Number.isSafeInteger(child.header.delegationDepth)
        || child.header.delegationDepth !== (parent.header.delegationDepth ?? 0) + 1) continue
      const selections = child.rows.filter(row => row.type === 'agent-preset/selected')
      if (selections.some(row => row.event?.data?.agentPreset !== child.header.agentPreset)) continue
      const descriptors = child.rows.filter(row => row.type === 'subagent/descriptor' && row.event?.data?.version === 3
        && ['continuable', 'one-shot'].includes(row.event.data.mode) && row.event.data.provider === 'spawn')
      if (descriptors.length !== 1) continue
      const descriptor = descriptors[0]!
      const task = child.rows.find(row => row.type === 'user/message' && (row.event?.data?.message ?? row.event?.data)?.source?.kind === 'user')
      const message = task?.event?.data?.message ?? task?.event?.data, text = taskText(message)
      if (!task || !text || descriptor.ref.seq === null || task.ref.seq === null || task.ref.seq <= descriptor.ref.seq) continue
      const matches: { call: TraceEvent; result: TraceEvent; catalog: TraceEvent }[] = []
      for (const result of parent.rows) {
        const data = result.event?.data, reply = data?.message
        if (result.type !== 'tool/result' || reply?.source?.kind !== 'tool' || reply.isError || data?.error) continue
        const callId = reply.source.callId
        if (typeof callId !== 'string' || !callId) continue
        const calls = parent.rows.filter(row => row.type === 'tool/call' && row.event?.data?.callId === callId)
        if (calls.length !== 1 || reply.toolCallId !== undefined && reply.toolCallId !== callId) continue
        const call = calls[0]!, response = taskText(reply)
        if (response?.trim() !== `started subagent ${child.header.id}` || typeof call.event?.data?.name !== 'string') continue
        let args = call.event?.data?.arguments
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { continue } }
        if (typeof args?.prompt !== 'string' || !args.prompt.trim() || !text.includes(args.prompt)) continue
        const catalogs = parent.rows.filter(row => row.type === 'subagent/catalog' && row.event?.data?.version === 0
          && row.event.data.childId === child.header.id && row.event.data.childCreatedAt === child.header.createdAt
          && row.event.data.mode === descriptor.event?.data?.mode && row.ref.seq !== null && call.ref.seq !== null && result.ref.seq !== null
          && call.ref.seq < row.ref.seq && row.ref.seq < result.ref.seq)
        if (catalogs.length === 1) matches.push({ call, result, catalog: catalogs[0]! })
      }
      if (matches.length !== 1) continue
      const { call, result, catalog } = matches[0]!
      lineages.set(child.log, { kind: 'delegated_task', root_session_id: root.header.id, root_session_log: root.log,
        parent_session_id: parent.header.id, parent_session_log: parent.log, actor_session_id: child.header.id, session_log: child.log,
        delegation: { tool_name: call.event!.data.name, call_id: call.event!.data.callId, call_ref: call.ref, result_ref: result.ref, catalog_ref: catalog.ref,
          descriptor_ref: descriptor.ref, header_ref: child.row.ref, task_ref: task.ref, task_content_sha256: hash(text) } })
      trusted.set(child.header.id, child); changed = true
    }
  }
  return events.map(row => {
    const lineage = row.ref.session_log && lineages.get(row.ref.session_log)
    if (!lineage) return row
    const { warning, ...rest } = row
    return { ...rest, role: 'target' as const, lineage,
      ...(warning && !warning.startsWith('子会话或缺少 Session 日志定位') ? { warning } : {}) }
  })
}

/** 保留原 JSONL 行号和原字节摘要；脱敏与解析不会改写源文件。 */
export function parseTraceText(text: string, source: Pick<TraceSource, 'path' | 'role'> & Partial<TraceSource>, sourceSha256 = hash(text)): TraceEvent[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const events = lines.map((line, index) => {
    const ref: TraceRef = { path: source.path, line: index + 1, session_log: null, event_id: null, seq: null, source_sha256: sourceSha256, line_sha256: hash(line) }
    const base = { ref, role: source.role, collection_status: source.collection_status }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return { ...base, type: 'unavailable', status: 'oversized', warning: `原始行超过 ${MAX_LINE_BYTES} 字节，内容未送入模型；该行后仍继续分页。` }
    try {
      const envelope = map(JSON.parse(line))
      const raw = map(envelope?.event) ?? envelope
      if (!raw || typeof raw.type !== 'string') return { ...base, type: 'unavailable', status: 'malformed', warning: '该行不是包含事件 type 的 JSON 对象。' }
      const safe = redact(raw)
      const log = asString(envelope?.session_log)
      // DSH 导出根日志位于归档根目录；descendants 的身份不能继承根智能体角色。
      const role: TraceRole = log && !/[\\/]/.test(log) ? source.role : 'unknown'
      const eventId = asString(raw.id) ?? asString(raw.data?.id) ?? asString(raw.data?.message?.id)
      ref.session_log = log
      ref.event_id = eventId
      ref.seq = Number.isSafeInteger(raw.seq) ? raw.seq : null
      const known = KNOWN_TYPES.has(raw.type)
      return { ...base, role, type: raw.type, status: known ? 'valid' : 'unknown', event: safe,
        ...(!known ? { warning: '未知事件保留原始结构，不推断业务语义。' } : role !== source.role ? { warning: '子会话或缺少 Session 日志定位，不能继承根轨迹的智能体角色。' } : {}) }
    } catch { return { ...base, type: 'unavailable', status: 'malformed', warning: '该行无法解析为 JSON；未把原始坏行送入模型。' } }
  }) as TraceEvent[]
  return assignTargetLineage(events, source)
}

export async function loadRunTrace(root: string, input: Pick<RunTraceInput, 'run_id' | 'path' | 'source_sha256'>, signal?: AbortSignal, includeCatalog = true) {
  // 单文件分片和来源复核只依赖该文件及其清单，不重复枚举其他 Case 的证据。
  const selected = !includeCatalog && input.path ? await readRunEvidenceFile(root, input.run_id, input.path, signal) : null
  if (selected && !tracePath(selected.path)) throw new RunFileError('not_found', '所选文件不是 Session 轨迹')
  const files = selected ? [] : await listRunTraceSources(root, input.run_id, signal)
  const source = selected ? { path: selected.path, size: selected.data.length }
    : input.path ? files.find(file => file.path === input.path || file.path.endsWith(`/runs/${input.run_id}/${input.path}`)) : files.find(file => file.role === 'target' && file.collection_status !== 'unavailable') ?? files[0]
  if (!source) throw new RunFileError('not_found', '所选 Run 中没有此 Session 轨迹')
  const base = source.path.slice(0, source.path.indexOf(`/runs/${input.run_id}`) + `/runs/${input.run_id}`.length)
  const directory = posix.dirname(source.path)
  const paths = [source.path, `${base}/run.yaml`, `${base}/run.json`, `${base}/inputs.lock.json`, `${directory}/checks.json`, `${directory}/judge.json`]
  const captured = new Map<string, Awaited<ReturnType<typeof readRunEvidenceFile>> | null>(selected ? [[selected.path, selected]] : [])
  for (const path of [...new Set(paths)]) {
    if (captured.has(path)) continue
    try { captured.set(path, await readRunEvidenceFile(root, input.run_id, path, signal)) }
    catch (error) { if (error instanceof RunFileError && error.code === 'not_found' && path !== source.path) captured.set(path, null); else throw error }
  }
  const file = captured.get(source.path)!
  if (!file) throw new RunFileError('not_found', '所选轨迹不存在')
  if (input.source_sha256 && input.source_sha256 !== file.source_sha256) throw new RunFileError('conflict', '轨迹在读取期间发生变化，请重新开始', { path: source.path })
  const issues: string[] = []
  function json(path: string) { try { return map(JSON.parse(captured.get(path)?.data.toString('utf8') ?? 'null')) } catch { issues.push(`${path} 无法解析`); return null } }
  const inputs = json(`${base}/inputs.lock.json`), checks = json(`${directory}/checks.json`), judge = json(`${directory}/judge.json`)
  const actualSource = classifySource(source, base, inputs, checks, judge)
  const manifests = [`${base}/run.yaml`, `${base}/run.json`].filter(path => captured.get(path))
  if (!manifests.length) issues.push('缺少 Run 身份文件')
  for (const path of manifests) {
    try {
      const raw = captured.get(path)!.data.toString('utf8'), value = map(path.endsWith('.yaml') ? loadYaml(raw) : JSON.parse(raw))
      if (value?.run_id !== input.run_id) issues.push('Run 身份文件的 run_id 与所选 Run 不一致')
      if (!['completed', 'failed', 'cancelled'].includes(value?.status)) issues.push('Run 尚未封存，不能固定决策来源')
    } catch { issues.push(`${path} 无法解析`) }
  }
  if (actualSource.role !== 'target') issues.push('来源不是已确认的目标智能体 Case 轨迹')
  if (actualSource.collection_status !== 'available') issues.push('采集记录没有确认可用的完整轨迹')
  const bundleFiles = [...captured].map(([path, value]) => ({ path, source_sha256: value?.source_sha256 ?? null })).sort((a, b) => a.path.localeCompare(b.path))
  const source_bundle: TraceSourceBundle = { schema_version: 1, sha256: hash(JSON.stringify(bundleFiles)), files: bundleFiles, issues }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data) }
  catch { throw new RunFileError('file_not_text', '轨迹必须是有效的 UTF-8 JSONL 文本') }
  const events = parseTraceText(text, actualSource, file.source_sha256)
  return { run_id: input.run_id, files: selected ? [actualSource] : files, source: actualSource, path: actualSource.path, warnings: actualSource.warnings, source_sha256: file.source_sha256, source_bundle, events, total_lines: events.length }
}

function visibleContent(value: any) {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : []
  // 隐式思维、压缩状态与 stream 不作为训练用的可观察决策输入。
  return value.filter(block => block && ['text', 'tool-call', 'tool-result', 'tool-addition', 'tool-removal', 'image', 'image_url', 'input_text', 'input_image'].includes(block.type))
}
function messageMeta(message: JsonMap, delegated?: TraceLineage) {
  const callId = asString(message.tool_call_id) ?? (message.source?.kind === 'tool' ? asString(message.source.callId) : null)
  const { replayState: _replayState, ...source } = map(message.source) ?? {}
  const actualSource = delegated ? { ...source, kind: 'subagent', senderSessionId: delegated.parent_session_id, delegationCallId: delegated.delegation.call_id } : source
  return { ...(typeof actualSource.kind === 'string' ? { source: actualSource } : {}), ...(callId ? { tool_call_id: callId } : {}), ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}), ...(typeof message.name === 'string' ? { name: message.name } : {}) }
}
function delegatedMessage(row: TraceEvent, message: any): TraceLineage | undefined {
  return row.lineage && message?.source?.kind === 'user' && taskText(message) !== null
    && hash(taskText(message)!) === row.lineage.delegation.task_content_sha256 ? row.lineage : undefined
}
function eventMessage(row: TraceEvent): TraceMessage | null {
  const data = row.event?.data ?? {}
  if (row.type === 'user/message') {
    const message = map(data.message) ?? data
    return { role: 'user', content: visibleContent(message.content), ref: row.ref, ...messageMeta(message, row.ref.line === row.lineage?.delegation.task_ref.line ? row.lineage : undefined) }
  }
  if (['assistant/message', 'system/message', 'developer/message'].includes(row.type)) {
    const message = map(data.message)
    return message ? { role: row.type.split('/')[0]!, content: visibleContent(message.content), ref: row.ref, ...messageMeta(message) } : null
  }
  if (row.type === 'tool/result') return { role: 'tool', content: data.message?.content ?? data.error ?? null, ref: row.ref, ...messageMeta(data.message ?? {}) }
  if (row.type === 'tool/call') return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: data.callId, toolName: data.name, args: data.arguments }], ref: row.ref }
  return null
}

function reconstructedMessages(before: TraceEvent[]): { messages: TraceMessage[]; issues: string[] } {
  if (before.some(row => row.event?.surfaceOp !== undefined || row.type === 'session' && row.event?.version === 4)) {
    // 使用锁定 DSH 的 surface 合同，替换或插件投影不可解释时不回退到追加历史。
    try {
      const rows = before.filter(row => row.type !== 'session' || row.ref.seq !== null)
      const events = rows.map(row => row.event as SessionEvent)
      const surface = foldSurface(events)
      const messages = surface.nodes.flatMap(seq => {
        const message = deriveEventMessage(events[seq]!, surface.projectedMessages)
        return message ? [{ role: message.role, content: visibleContent(message.content), ref: rows[seq]!.ref,
          ...messageMeta(message, rows[seq]!.ref.line === rows[seq]!.lineage?.delegation.task_ref.line ? rows[seq]!.lineage : undefined) }] : []
      })
      return { messages, issues: [] }
    } catch {
      return { messages: [], issues: ['无法按锁定 DSH 的 surface 合同重建当前上下文；检查事件序列、替换来源及所需插件投影，不作为训练样本。'] }
    }
  }
  const messages: TraceMessage[] = []
  const serializedCalls = new Set<string>()
  for (const row of before) {
    if (row.type === 'tool/call' && serializedCalls.has(row.event?.data?.callId)) continue
    const message = eventMessage(row)
    if (!message) continue
    if (row.type === 'assistant/message') {
      const calls = [...(Array.isArray(message.content) ? message.content.filter(block => block?.type === 'tool-call') : []), ...(Array.isArray(message.tool_calls) ? message.tool_calls : [])]
      for (const call of calls) { const id = asString(call.id) ?? asString(call.toolCallId) ?? asString(call.callId); if (id) serializedCalls.add(id) }
    } else if (row.type === 'tool/call' && typeof row.event?.data?.callId === 'string') serializedCalls.add(row.event.data.callId)
    messages.push(message)
  }
  return { messages, issues: [] }
}

function actualMessages(row: TraceEvent): any[] | null {
  const data = row.event?.data
  if (!data || !row.type.startsWith('request/')) return null
  for (const value of [data.header?.messages, data.header?.request?.messages, data.request?.messages, data.body?.messages, data.messages, data.header?.input, data.request?.input, data.body?.input, data.input]) {
    if (Array.isArray(value) && value.every(message => map(message) && typeof message.role === 'string')) return value
  }
  return null
}

/** 按每个 session 的原始行顺序重建，不按时间戳混排父子会话。 */
export function buildDecisionSlices(events: TraceEvent[]): DecisionSlice[] {
  const sessions = new Map<string, TraceEvent[]>()
  for (const row of events) {
    // 未标明 session_log 的记录只允许在同一源文件内分析，不合并其他文件。
    const key = `${row.ref.path}\u0000${row.ref.session_log ?? '<未记录Session>'}`
    const rows = sessions.get(key) ?? []
    rows.push(row); sessions.set(key, rows)
  }
  const slices: DecisionSlice[] = []
  for (const rows of sessions.values()) {
    let request = -1, step = -1
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!
      if (['turn/start', 'turn/end', 'step/end'].includes(row.type)) { request = -1; step = -1 }
      if (row.type === 'step/start') step = index
      if (row.type === 'request/header' || actualMessages(row)) request = index
      if (row.type !== 'tool/call' && row.type !== 'assistant/message') continue
      const data = row.event?.data ?? {}
      // 一次模型输出已包含工具选择时，只建立实际 tool/call 决策，避免把同一输出重复当最终答复。
      const actionContent = visibleContent(data.message?.content)
      if (row.type === 'assistant/message' && (!actionContent?.length || (actionContent as any[])?.some?.(block => block.type === 'tool-call'))) continue
      const sameStepRequest = request >= 0 && (step < 0 || request > step)
      let cutoff = sameStepRequest ? request : step >= 0 ? step : index
      if (sameStepRequest) {
        // 请求头之后仍可能装入工具声明或上下文；本批首个输出及后续执行结果不进入输入。
        for (let at = request + 1; at < index; at++) {
          if (['assistant/message', 'tool/call'].includes(rows[at]!.type)) break
          cutoff = at + 1
        }
      }
      if (!sameStepRequest && step < 0) {
        // 无请求边界时保守回退到本批第一个输出之前；连续工具共享同一前缀。
        while (cutoff > 0 && ['assistant/message', 'tool/call'].includes(rows[cutoff - 1]!.type)) cutoff--
      }
      const before = rows.slice(0, cutoff)
      const req = sameStepRequest ? rows[request]! : null
      let actual: any[] | null = req ? actualMessages(req) : null
      if (sameStepRequest && !actual) {
        for (let at = request + 1; at < index; at++) if (actualMessages(rows[at]!)) { actual = actualMessages(rows[at]!); break }
      }
      let delegatedSeen = false
      const context = actual ? { messages: actual.map(message => {
        const delegated = !delegatedSeen && message.role === 'user' ? delegatedMessage(req!, message) : undefined
        if (delegated) delegatedSeen = true
        return { role: message.role, content: visibleContent(message.content), ref: req!.ref, ...messageMeta(message, delegated) }
      }), issues: [] }
        : reconstructedMessages(before)
      const messages: TraceMessage[] = context.messages
      const limitations = ['仅保留可观察事件；没有显式证据时不推断私有思维、备选动作或因果归因。', ...context.issues]
      if (!actual) limitations.push('未取得完整模型请求 messages；前缀由同 Session 的可观察历史重建，不能声称与实际模型上下文完全一致。')
      if (!sameStepRequest && step < 0) limitations.push('缺少请求或 step 边界，决策前缀采用保守截点。')
      if (!row.ref.session_log) limitations.push('未记录 session_log，仅按当前文件隔离，Session 身份未知。')
      const gaps = events.some(item => item.ref.path === row.ref.path && item.ref.line < row.ref.line && (item.status === 'malformed' || item.status === 'oversized') && (!item.ref.session_log || item.ref.session_log === row.ref.session_log))
      if (gaps) limitations.push('前缀含无法解析或超大原始行，上下文不完整。')
      if (row.collection_status === 'unavailable') limitations.push('采集记录明确表明轨迹不可用，不作为训练样本。')
      if (row.role !== 'target') limitations.push('不是已确认的目标智能体轨迹，仅供审查，不作为默认训练样本。')
      if (row.lineage) limitations.push('已核验目标执行的父子委派链；初始子任务来自父智能体，不代表真人请求或确认授权。')
      const kind = row.type === 'tool/call' ? 'tool_call' : 'assistant_response'
      const callId = asString(data.callId)
      const result = callId ? rows.slice(index + 1).find(item => item.type === 'tool/result' && item.event?.data?.message?.source?.kind === 'tool' && item.event.data.message.source.callId === callId) : undefined
      let args: unknown = data.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { limitations.push('工具参数不是合法 JSON，按原始脱敏文本保留。') } }
      const header = rows.slice(0, cutoff + 1).filter(item => item.type === 'request/header').at(-1)?.event?.data?.header
      const outcome = result ? { status: 'observed' as const, refs: [result.ref], result: result.event?.data } : { status: 'missing' as const, refs: [] }
      if (row.lineage && kind === 'tool_call' && !result) limitations.push('本次子工具结果未保存；只能观察动作选择，不能作为执行成功或业务结论证据。')
      slices.push({
        id: `decision-${hash(JSON.stringify([row.ref.path, row.ref.source_sha256, row.ref.line, row.ref.session_log])).slice(0, 20)}`,
        kind, role: row.role, anchor: row.ref, request_ref: req?.ref ?? null,
        state: { messages, route: header?.config ?? null, available_tools: header?.tools ?? null },
        context_refs: [...before.map(item => item.ref), ...(req ? [req.ref] : [])],
        context_mode: actual ? 'actual_request' : messages.length ? 'reconstructed' : 'unavailable',
        observed_action: kind === 'tool_call' ? { name: String(data.name ?? ''), arguments: args, ...(callId ? { call_id: callId } : {}) } : { name: 'respond', content: visibleContent(data.message?.content) },
        outcome_refs: outcome.refs, outcome,
        eligible: row.role === 'target' && row.collection_status !== 'unavailable' && messages.length > 0 && !gaps && (sameStepRequest || step >= 0),
        limitations,
        ...(row.lineage ? { lineage: row.lineage } : {}),
      })
    }
  }
  for (const slice of slices) if (slice.lineage) {
    const root = slices.find(value => value.role === 'target' && value.anchor.path === slice.anchor.path
      && value.anchor.session_log === slice.lineage!.root_session_log)
    if (root) slice.source_group_id = decisionSourceGroup(root.state, root.anchor.session_log)
  }
  return slices
}

export async function readRunTrace(root: string, input: RunTraceInput, signal?: AbortSignal) {
  if (!input || typeof input.run_id !== 'string') throw new RunFileError('invalid_request', '缺少 run_id')
  const cursor = input.cursor ?? 0, limit = input.limit ?? 80
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RunFileError('invalid_request', 'cursor 必须是非负行偏移，limit 须在 1–500 之间')
  const files = await listRunTraceSources(root, input.run_id, signal)
  if (!files.length) return { run_id: input.run_id, files, events: [], decisions: [], total_lines: 0, next_cursor: null, warnings: ['该 Run 未保存 Session 轨迹，无法抽取决策样本。'] }
  const loaded = await loadRunTrace(root, input, signal)
  const events: TraceEvent[] = []
  const decisions: DecisionSlice[] = []
  const allDecisions = new Map(buildDecisionSlices(loaded.events).map(slice => [slice.anchor.line, slice]))
  let next = cursor, bytes = 0
  for (; next < loaded.events.length; next++) {
    const row = loaded.events[next]!
    if (input.session_log && row.ref.session_log !== input.session_log) continue
    let decision = allDecisions.get(row.ref.line)
    if (decision && Buffer.byteLength(JSON.stringify(decision)) > PAGE_BYTES / 2) {
      // 界面是有界预览；数据集必须使用 loadRunTrace + buildDecisionSlices 的完整切片。
      decision = { ...decision, eligible: false, state: { messages: [], available_tools: null, route: null }, context_refs: [],
        observed_action: { name: decision.observed_action.name, ...(decision.observed_action.call_id ? { call_id: decision.observed_action.call_id } : {}) },
        outcome: { status: decision.outcome.status, refs: decision.outcome.refs },
        limitations: [...decision.limitations, '该决策的完整上下文超过界面单页预算，界面不展示输入、参数与结果正文；抽取器仍须读取完整切片。'] }
    }
    const size = Buffer.byteLength(JSON.stringify(row)) + (decision ? Buffer.byteLength(JSON.stringify(decision)) : 0)
    if (events.length && (events.length >= limit || bytes + size > PAGE_BYTES)) break
    events.push(row); if (decision) decisions.push(decision); bytes += size
  }
  return { run_id: input.run_id, files: loaded.files, path: loaded.source.path, source: loaded.source, source_sha256: loaded.source_sha256,
    events, decisions, total_lines: loaded.total_lines,
    next_cursor: next < loaded.total_lines ? next : null, warnings: loaded.source.warnings }
}
