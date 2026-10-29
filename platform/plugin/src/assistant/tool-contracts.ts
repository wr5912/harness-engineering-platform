import { z } from 'zod'
import { businessCasesSchema } from '../agents/business-cases.ts'

export type AssistantDomain = 'agents' | 'instances' | 'mcp'
type MapValue = Record<string, any>
export const assistantActions: Record<AssistantDomain, readonly string[]> = {
  agents: ['research/read-reference', 'research/validate', 'legacy/inspect', 'decision/preview', 'list', 'detail', 'edit/read', 'edit/preview', 'edit/apply', 'cases/list', 'cases/read', 'cases/update', 'eval/preview', 'eval/start', 'eval/status', 'eval/cancel', 'runs/index', 'runs/show', 'runs/evidence', 'runs/report', 'runs/files', 'runs/read-file', 'runs/compare', 'runs/trace', 'assets/diff', 'assets/read-fixed', 'compute-variants/context', 'compute-variants/preview', 'compute-variants/create', 'compute-variants/rename', 'compute-variants/build-preview', 'compute-variants/build', 'compute-variants/freeze-preview', 'compute-variants/freeze', 'compute-variants/compare', 'new', 'create', 'cases/create-context', 'cases/from-run', 'cases/create-preview', 'cases/create', 'datasets/source', 'datasets/preview', 'datasets/apply', 'datasets/list', 'datasets/read', 'datasets/export', 'decision/update', 'features/read-source', 'features/preview', 'features/proposal', 'features/apply', 'fusion/preview', 'fusion/proposal', 'fusion/confirm', 'fusion/status', 'fusion/verify', 'fusion/finalize', 'tasks/capabilities', 'tasks/assembly-preview', 'tasks/assembly-apply'],
  instances: ['list', 'detail', 'url', 'logs', 'preview', 'batch-preview', 'run', 'batch'],
  mcp: ['list', 'configuration', 'saveConfiguration', 'test', 'resources', 'resourceTemplates', 'readResource', 'callTool', 'sources/list', 'sources/create', 'sources/refresh', 'sources/toggle', 'sources/components', 'sources/logs', 'sources/preview', 'sources/invoke', 'saveCompositionDraft', 'publishComposition', 'executeComposition', 'dryRunComposition', 'callPublishedComposition', 'compositionRun', 'compositionArtifact', 'seedThreatCompositions', 'control/status', 'control/saveConfiguration', 'control/restrict', 'control/reassess', 'control/release'],
}

export const featureActions = ['research/read-reference', 'detail', 'edit/read', 'assets/diff', 'assets/read-fixed', 'features/read-source', 'features/preview', 'features/proposal', 'runs/index', 'runs/show', 'runs/report', 'runs/files', 'runs/read-file', 'runs/trace']
export function allowedAssistantActions(domain: AssistantDomain, state: any): readonly string[] {
  const context = state?.task_context ?? {}
  if (context.skill === 'decision-sample-extraction') return domain === 'agents' ? ['research/read-reference', 'datasets/source', 'datasets/preview', 'datasets/list'] : []
  if (context.skill === 'agent-maintenance' && context.workflow === 'features') return domain === 'agents' ? featureActions : []
  if (context.skill === 'compute-variant-research') return domain === 'agents'
    ? assistantActions.agents.filter(action => /^(compute-variants\/|research\/|assets\/|edit\/|eval\/|runs\/|decision\/|cases\/)/.test(action) || ['list', 'detail', 'tasks/capabilities'].includes(action)) : []
  return assistantActions[domain]
}

const string = { type: 'string' }, strings = { type: 'array', items: string }, object = { type: 'object', additionalProperties: true }
const fields: MapValue = {
  case_ids: strings, critical_case_ids: strings, cases: strings, inputs: strings, artifacts: strings, parent_run_ids: strings, variant_run_ids: strings,
  fast: { type: 'boolean' }, enabled: { type: 'boolean' }, allow_missing_env: { type: 'boolean' },
  business_control: { type: 'boolean', description: '创建业务实例默认且必须经过统一网关；不能用 false 绕过网关。已有实例的生命周期沿用其登记。' },
  access_mode: { type: 'string', enum: ['authenticated', 'anonymous'], description: '业务实例访问方式；anonymous 为无需登录的局域网匿名访问。' },
  identity_mode: { type: 'string', enum: ['development', 'published'], description: '业务实例身份验证阶段。' },
  min_runs_per_case: { type: 'integer' }, max_pass_rate_drop_pp: { type: 'number' }, min_resource_reduction_pct: { type: 'number' }, allow_model_change: { type: 'boolean' }, generation: object,
  port: { type: 'integer' }, tail: { type: 'integer' }, cursor: { type: 'integer' }, limit: { type: 'integer' },
  arguments: { ...object, description: '使用 test 或 sources/components 返回的真实工具 inputSchema，不猜测参数。' },
  input: { ...object, description: '业务工具输入，使用当前工具目录返回的 inputSchema。' },
  plan: object,
  evaluation_cases: z.toJSONSchema(businessCasesSchema, { io: 'input' }),
  edits: { type: 'array', items: { type: 'object', required: ['path', 'content', 'expected_sha256'], additionalProperties: false,
    properties: { path: string, content: { ...string, description: '修改后完整文件正文，不能省略或只提供补丁。' }, expected_sha256: { type: ['string', 'null'], description: 'edit/read 返回的原始摘要；新文件为 null。' } } } },
  features: { type: 'array', items: { type: 'object', required: ['id', 'title', 'description'], additionalProperties: false,
    properties: { id: string, title: string, description: string, source_refs: strings, evidence_refs: strings, change: string } } },
  ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['set', 'unset'] }, path: strings, value: {} }, required: ['op', 'path'] } },
  draft: { ...object, description: '按 list 返回的现有编排结构及已装载业务扩展编辑；由 compositionConfig 校验。' },
  bindings: object, artifact_export: object, files: { type: 'array', items: object }, configuration_edits: { type: 'array', items: object },
  items: { type: 'array', items: object }, expected_device_ids: strings, required_case_ids: strings, required_tool_names: strings,
  agents: { type: 'array', items: object }, scope: object, deniedActions: strings,
  sessionId: string, restrictionId: string, reason: string, action: string,
}
type Hint = [actions: string, input: string, note?: string]
// 这里是模型的逐操作用法索引，不是第二套业务校验器；完整语义仍由原接口处理。
const hints: Record<AssistantDomain, Hint[]> = {
  instances: [
    ['list', ''], ['detail url', 'name'], ['logs', 'name tail'],
    ['preview run', 'name operation source port allow_missing_env business_control access_mode identity_mode', 'operation=create/start/stop/restart/delete；创建必须传明确的 experiment:<ID> 来源。创建业务实例默认且必须经过统一网关，默认 access_mode=anonymous、identity_mode=development；可明确选择 authenticated 或 published。网关不可用时说明原因并修复配置，禁止省略参数或传 false 改为直连。独立研究评测使用 agents/eval 入口，不用业务实例创建接口绕过网关。用户要求最新版本时，先用 agents/detail 的 versions[0].id 确定版本，再作为 source 传入；默认 detail.experiment 可能是已启用版本，不等于最新版本。直接调用 run 即可由平台内部预览并核对模型、业务来源摘要与访问设置，按 DSH 原生权限执行；无需另调 preview 或额外索取确认。业务实例创建后用 instances/url 取统一网关入口，不要把容器直连端口当作业务链接。'],
    ['batch-preview batch', 'items', 'items 为多个与 run 相同的操作对象；逐项核对结果，部分失败不能称为全部完成。'],
  ],
  mcp: [
    ['list configuration', '', '先读取当前目录、公开配置及字符串 revision；凭据仅返回已配置状态，通过 MCP 管理页面维护。'],
    ['saveConfiguration', 'ops revision', 'revision 使用 configuration 返回的字符串；修改路径使用字符串数组，只修改单个服务的公开字段。新增服务可写入 servers 的末尾索引；凭据和 Header 值通过页面维护。'],
    ['test resources resourceTemplates sources/list', 'serverId', 'serverId 来自当前配置。test 和 sources/components 提供真实可用工具及其输入合同。'],
    ['sources/components sources/logs sources/refresh', 'serverId sourceId'],
    ['readResource', 'serverId uri'], ['callTool', 'serverId toolName arguments', '先读取实际工具 inputSchema，再传 arguments；执行遵循 DSH 原生权限。'],
    ['sources/create', 'serverId name specUrl', '向当前配置的管理服务创建 OpenAPI 来源。'],
    ['sources/toggle', 'serverId sourceId enabled'], ['sources/preview sources/invoke', 'serverId sourceId toolName arguments', '按 sources/components 返回的组件合同提供参数。'],
    ['saveCompositionDraft', 'compositionId revision draft', 'revision 来自 list；新编排省略 compositionId，更新时必须指定已有 ID。'],
    ['publishComposition executeComposition dryRunComposition', 'compositionId version revision input', '先保存草稿；version=draft/published，发布只接受 draft；使用当前 revision。'],
    ['callPublishedComposition', 'toolName input', '服务器从当前目录固定实际已发布版本，按 DSH 原生权限执行。'],
    ['compositionRun', 'run_id'], ['compositionArtifact', 'run_id artifactId'], ['seedThreatCompositions', 'revision bindings', '仅在业务扩展实际装载且用户要求时使用。'],
    ['control/status', '', '读取基础许可、风险事实、限制与真实实例回执；定时任务不在首期覆盖范围。'],
    ['control/saveConfiguration', 'revision enabled agents', '使用 control/status 的字符串 revision 和当前 agents 规则；只修改开放与基础授权，不发送凭据。'],
    ['control/restrict', 'scope deniedActions reason', 'scope 至少指定 workspaceId、agentId、subjectId；使用已登记实例及主体，动作 read/write/publish。'],
    ['control/reassess', 'sessionId action', '重新评估当前 Session 的指定动作；不会执行或重放业务。'],
    ['control/release', 'restrictionId sessionId action', '重新评估后仅解除所选限制，其他约束保留；未知副作用先查实际结果，不能以恢复操作补发业务。'],
  ],
  agents: [
    ['list', ''], ['detail', 'agent_id experiment_id', '明确指定版本；未传 experiment_id 时 detail.experiment 优先是已启用版本，用户要求最新版本时应读取 versions[0].id。有固定任务目标时不要改成最新版本。'],
    ['research/read-reference', 'topic', 'topic=controlled-improvement/evaluation-and-evidence/inheritance-and-fusion/compute-variants/decision-samples。'],
    ['research/validate', 'experiment_id'], ['legacy/inspect', 'path', '仅检查 data evolution/history/imports 内的既有材料，不执行旧代码。'],
    ['new', 'agent_id name description role evaluation_cases', '先查 tasks/capabilities 复用已有能力；evaluation_cases 使用实际业务测试，ID 以 U- 开头（如 U-CHAT-GREET），身份测试由平台创建。'],
    ['create', 'agent_id parent_experiment_id parent_ref research_question', 'parent_ref 使用固定 git:<40位commit>；创建版本不表示已融合验证。'],
    ['edit/read', 'experiment_id path'], ['edit/preview edit/apply', 'experiment_id edits', '先 edit/read，每次提交实际文件正文和原摘要；写入遵循 DSH 原生权限与当前任务范围。'],
    ['assets/diff', 'experiment_id path against baseline_experiment_id', '先省略 path 列差异，再用返回的 path 读完整差异；against=baseline 或指定比较方式。'], ['assets/read-fixed', 'agent_id experiment_id ref path', 'ref 必须为固定 git:<40位commit>；省略 path 可先列目录。'],
    ['cases/list cases/create-context', 'agent_id experiment_id'], ['cases/read', 'agent_id experiment_id case_id'],
    ['cases/from-run', 'agent_id experiment_id run_id case_id'],
    ['cases/update cases/create-preview cases/create', 'agent_id experiment_id case_id title scene inputs expected_behavior fast expected_sha256 source_run_id source_case_id', '先读用例或 create-context；inputs 为非空字符串数组，expected_sha256 取原文件摘要。新建先 create-preview。'],
    ['eval/preview eval/start', 'source cases mode executor review model compare_to artifact_export', 'source=experiment:<ID>；cases 为固定 Case ID 数组。preview 不执行评测，start 返回 job_id。'],
    ['eval/status eval/cancel', 'job_id'], ['runs/index', 'agent_id experiment_id'],
    ['runs/show', 'run_id case_id'], ['runs/report runs/files', 'run_id'], ['runs/read-file', 'run_id path'],
    ['runs/evidence', 'run_id case_id filename'], ['runs/compare', 'left right case_id'], ['runs/trace', 'run_id path source_sha256 cursor limit session_log'],
    ['decision/preview decision/update', 'experiment_id content expected_sha256 status outcome expected_change_sha256', '修改 status/outcome 时还须 detail 返回的 change 摘要；status=active/completed，outcome=adopt/continue/reject/inconclusive。'],
    ['features/read-source', 'experiment_id ref', '先省略 ref 获取来源文件，再逐个读取。'],
    ['features/preview', 'experiment_id features', '固定目标特性整理任务自动保存并回读；保留证据和未验证边界，不需人工确认。'],
    ['features/proposal', 'experiment_id'], ['features/apply fusion/confirm datasets/apply', 'preview_id', '此操作由既有确认或固定目标专项保存流程办理；不要绕过原预览身份。'],
    ['fusion/preview', 'agent_id parent_experiment_id parent_ref research_question plan', '先省略 plan 读取 inventory。融合 plan={sources:[{experiment_id,ref,decision:inherit/omit,reason}],features,conflicts:[{description,resolution}],checks:[{id,kind:build/load/capability,command?,cwd?,case_ids?}],evaluation_case_ids,evaluation_sha256}；来源和评测摘要使用实际读取值。'],
    ['fusion/proposal', 'agent_id parent_experiment_id'], ['fusion/status fusion/finalize', 'experiment_id'],
    ['fusion/verify', 'experiment_id expected_candidate_sha256 check_id run_id'],
    ['datasets/source', 'run_id path source_sha256 cursor', '先省略 path 列来源及 extraction_contract，再逐页读取 target 轨迹。'],
    ['datasets/preview', 'run_id path source_sha256 samples skipped', '遵循 datasets/source 的 extraction_contract；固定 Run 专项自动保存并回读，样本仍为 suggested。'],
    ['datasets/list', 'run_id'], ['datasets/read', 'dataset_id'], ['datasets/export', 'dataset_id mode', 'mode=candidates/training/development/calibration/test。candidates 可导出候选，其余仅导出符合对应用途且已由人员逐题复核的题目。'],
    ['compute-variants/context', 'experiment_id', '先读取 generation_contract 和固定父版；不凭空编造 SDK 能力。'],
    ['compute-variants/preview compute-variants/create', 'agent_id parent_experiment_id parent_ref variant_name strategy case_ids critical_case_ids min_runs_per_case max_pass_rate_drop_pp resource_metric min_resource_reduction_pct allow_model_change variant_model variant_reasoning_effort generation', '使用 context 返回的生成合同；名称与策略分别提供。'],
    ['compute-variants/rename', 'experiment_id variant_name expected_change_sha256'],
    ['compute-variants/build-preview compute-variants/build', 'experiment_id entry_path expected_candidate_sha256 expected_preview_sha256', '先读取源码后构建；执行时服务器生成并校验真实构建预览。'],
    ['compute-variants/freeze-preview compute-variants/freeze', 'experiment_id case_ids evaluation_base_sha256 expected_preview_sha256', '使用 freeze-preview 返回的 freeze_input，核对真实差异与摘要；冻结遵循 DSH 原生权限；不得用 human_confirmed 代替人员复核。'],
    ['compute-variants/compare', 'experiment_id parent_run_ids variant_run_ids', '比较固定父版与变体的真实 Run；助手不能确认 end。'],
    ['tasks/capabilities', 'agent_id source server_id'],
    ['tasks/assembly-preview tasks/assembly-apply', 'target_source expected_candidate_sha256 files configuration_edits', 'files[{source,path,target_path?,expected_source_sha256,expected_target_sha256}]；configuration_edits[{path,content,expected_target_sha256}]，摘要取真实来源。'],
  ],
}

export function assistantActionContract(domain: AssistantDomain, action: string) {
  const hint = hints[domain].find(([names]) => names.split(' ').includes(action))
  if (!hint) throw new Error('未知的领域操作合同')
  const properties = Object.fromEntries(hint[1].split(' ').filter(Boolean).map(key => [key, fields[key] ?? (/^(?:.*_id|.*_sha256|.*_ref|agent_id|source|target_source|name|description|role|path|ref|content|title|scene|expected_behavior|mode|executor|review|model|compare_to|left|right|filename|status|outcome|operation|serverId|sourceId|componentId|compositionId|artifactId|toolName|specUrl|uri|version|revision|topic|variant_name|strategy|resource_metric|variant_model|variant_reasoning_effort|entry_path|check_id)$/.test(key) ? string : {})]))
  return { domain, action, input_schema: { type: 'object', properties, additionalProperties: true },
    instructions: hint[2] ?? '使用先前实际返回的对象标识；缺少目标先查询目录。输入由原业务接口校验，错误时核对具体字段，不重放结果未知的写操作。' }
}

/** DSH 只接收有限 JSON Schema；数值和长度约束保留为说明，实际 Zod 解析不变。 */
function nativeSchema(schema: MapValue): MapValue {
  const result: MapValue = {}
  const constraints: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, nativeSchema(child as MapValue)]))
    else if (['items', 'additionalProperties'].includes(key) && typeof value === 'object') result[key] = nativeSchema(value)
    else if (key === 'type' && Array.isArray(value)) result.oneOf = value.map(type => ({ type }))
    else if (['oneOf', 'anyOf'].includes(key)) result.oneOf = value.map(nativeSchema)
    else if (['type', 'required', 'additionalProperties', 'enum', 'const', 'description', 'title', 'default', 'examples'].includes(key)) result[key] = value
    else if (key !== '$schema') constraints.push(`${key}=${JSON.stringify(value)}`)
  }
  if (constraints.length) result.description = [result.description, `接口校验：${constraints.join('；')}`].filter(Boolean).join('。')
  return result
}

/** describe 是模型适配层的只读动作，不注册为公共业务 RPC。 */
export function projectAssistantTools<T extends { name: string }>(tools: readonly T[], state: any): T[] {
  return tools.flatMap(tool => {
    const domain = tool.name.replace(/^platform_/, '') as AssistantDomain
    if (!Object.hasOwn(assistantActions, domain) || !tool.name.startsWith('platform_')) return [tool]
    const allowed = allowedAssistantActions(domain, state)
    if (!allowed.length) return []
    const selected = state?.tool_contracts?.[domain]
    const contract = allowed.includes(selected) ? assistantActionContract(domain, selected) : undefined
    return [{ ...tool,
      description: `平台${domain}工具。先用 describe(input.action=操作名)查看单个操作合同，再执行该动作；context读取固定目标。可随时describe切换其他合法动作。${contract ? `当前操作 ${selected}：${contract.instructions}` : '先查已有对象和能力，再构建、评测、改进或交付。'}确认和实际执行结果以平台回执为准。`,
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['context', 'describe', ...(contract ? [selected] : [])] },
        input: { type: 'object', properties: { ...contract && nativeSchema(contract.input_schema).properties,
          action: { type: 'string', enum: [...allowed], description: '仅 describe 使用：需要查看的操作名。' } }, additionalProperties: true,
          description: contract ? '执行当前操作时使用所示字段；context 使用空对象，describe 使用 action。完整业务语义由原接口校验。' : '不确定参数时先 describe；input={action:"操作名"}。' },
      }, required: ['action', 'input'], additionalProperties: false },
    }]
  })
}
