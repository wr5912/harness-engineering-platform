import { z } from 'zod'
import { businessCasesSchema } from '../agents/business-cases.ts'
import { DECISION_EXTRACTION_CONTRACT } from '../evaluation/decision-dataset-contract.ts'

export type AssistantDomain = 'agents' | 'instances' | 'mcp'
type MapValue = Record<string, any>
const migrationActions = ['migrations/inspect', 'migrations/read', 'migrations/preview', 'migrations/apply', 'migrations/status', 'migrations/resolve', 'assets/build-preview', 'assets/build', 'assets/dependencies/prepare']
export const assistantActions: Record<AssistantDomain, readonly string[]> = {
  agents: ['sdk/start', 'sdk/status', 'sdk/stop', 'sdk/list', 'sdk/guide', ...migrationActions, 'documents/read', 'research/read-reference', 'research/validate', 'legacy/inspect', 'decision/preview', 'list', 'detail', 'edit/read', 'edit/preview', 'edit/apply', 'cases/list', 'cases/read', 'cases/update', 'eval/preview', 'eval/start', 'eval/status', 'eval/cancel', 'runs/index', 'runs/show', 'runs/evidence', 'runs/report', 'runs/files', 'runs/read-file', 'runs/compare', 'runs/trace', 'assets/diff', 'assets/read-fixed', 'compute-variants/context', 'compute-variants/source', 'compute-variants/identity-preview', 'compute-variants/identity-apply', 'compute-variants/preview', 'compute-variants/create', 'compute-variants/rename', 'compute-variants/build-preview', 'compute-variants/build', 'compute-variants/freeze-preview', 'compute-variants/freeze', 'compute-variants/compare', 'new', 'create', 'cases/create-context', 'cases/from-run', 'cases/create-preview', 'cases/create', 'datasets/source', 'datasets/preview', 'datasets/apply', 'datasets/list', 'datasets/read', 'datasets/review', 'datasets/export', 'decision/update', 'features/read-source', 'features/preview', 'features/proposal', 'features/apply', 'fusion/preview', 'fusion/proposal', 'fusion/confirm', 'fusion/status', 'fusion/verify', 'fusion/finalize', 'tasks/capabilities', 'tasks/assembly-preview', 'tasks/assembly-apply'],
  instances: ['list', 'detail', 'url', 'logs', 'preview', 'batch-preview', 'run', 'batch'],
  mcp: ['list', 'configuration', 'saveConfiguration', 'test', 'resources', 'resourceTemplates', 'readResource', 'callTool', 'sources/list', 'sources/create', 'sources/refresh', 'sources/toggle', 'sources/components', 'sources/logs', 'sources/preview', 'sources/invoke', 'saveCompositionDraft', 'publishComposition', 'executeComposition', 'dryRunComposition', 'callPublishedComposition', 'compositionRun', 'compositionArtifact', 'compositionSource', 'seedThreatCompositions', 'control/status', 'control/saveConfiguration', 'control/restrict', 'control/reassess', 'control/release'],
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
  target: object, mapping: { type: 'array', items: object }, uncovered: strings, offset: { type: 'integer' }, model_bindings: object, project_workspace: object, role_instructions: object,
  resolutions: { type: 'array', items: object },
  declaration_paths: strings, target_platform: string, target_image: string, fingerprint: string,
  model_selection: { type: 'object', required: ['provider', 'model'], properties: { provider: string, model: string, reasoningEffort: string }, description: '原生模型选择，覆盖本次主角色选择；未传时使用指定版本绑定，再回落业务默认。' },
  profile: { type: 'string', enum: ['web', 'sdk'], description: '使用方式，默认web；sdk为同容器官方TypeScript SDK调用。' },
  case_ids: strings, critical_case_ids: strings, cases: strings, inputs: strings, artifacts: strings, parent_run_ids: strings, variant_run_ids: strings,
  fast: { type: 'boolean' }, enabled: { type: 'boolean' }, allow_missing_env: { type: 'boolean' },
  business_control: { type: 'boolean', description: '创建业务实例默认且必须经过统一网关；不能用 false 绕过网关。已有实例的生命周期沿用其登记。' },
  access_mode: { type: 'string', enum: ['authenticated', 'anonymous'], description: '业务实例访问方式；anonymous 为无需登录的局域网匿名访问。' },
  identity_mode: { type: 'string', enum: ['development', 'published'], description: '业务实例身份验证阶段。' },
  min_runs_per_case: { type: 'integer' }, max_pass_rate_drop_pp: { type: 'number' }, min_resource_reduction_pct: { type: 'number' }, allow_model_change: { type: 'boolean' }, generation: object,
  execution_mode: { type: 'string', enum: ['code-only', 'hybrid'] },
  model_roles: { ...object, description: 'hybrid 必填 {language,decision}；每项 provider/model/reasoning_effort，decision 另需 checkpoint_sha256/state_constructor_sha256/calibration_sha256。使用 generation_contract。' },
  port: { type: 'integer' }, tail: { type: 'integer' }, cursor: { type: 'integer' }, limit: { type: 'integer' },
  arguments: { ...object, description: '使用 test 或 sources/components 返回的真实工具 inputSchema，不猜测参数。' },
  input: { ...object, description: '业务工具输入，使用当前工具目录返回的 inputSchema。' },
  plan: object, selection: { ...object, description: '固定编排来源 {id,version:draft/published/version,versionId?}，使用实际目录返回的身份。' },
  workflow: string, task: { ...object, description: '沿用 datasets/read 的 {id,semantics}；semantics=recommended_decision 或 observed_action。' },
  questions: { ...object, description: '沿用公开决策合同的命名问题映射，每题含 type/instructions/criteria?。' },
  targets: { ...object, description: '与 questions 名称精确对应；每题只含 label、basis、probabilities?、status(reviewed/rejected)、decision_time_reviewed。' },
  split: { type: 'string', enum: ['unassigned', 'train', 'development', 'calibration', 'test'] },
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
    ['preview run', 'name operation source port allow_missing_env business_control access_mode identity_mode model_selection', 'operation=create/start/stop/restart/delete；创建必须传明确的 experiment:<ID> 来源。创建业务实例默认且必须经过统一网关，默认 access_mode=anonymous、identity_mode=development；可明确选择 authenticated 或 published。网关不可用时说明原因并修复配置，禁止省略参数或传 false 改为直连。独立研究评测使用 agents/eval 入口，不用业务实例创建接口绕过网关。用户要求最新版本时，先用 agents/detail 的 versions[0].id 确定版本，再作为 source 传入；默认 detail.experiment 可能是已启用版本，不等于最新版本。直接调用 run 即可由平台内部预览并核对模型、业务来源摘要与访问设置，按 DSH 原生权限执行；无需另调 preview 或额外索取确认。业务实例创建后用 instances/url 取统一网关入口，不要把容器直连端口当作业务链接。'],
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
    ['compositionSource', 'selection path expected_sha256', '省略 path 列实际源码目录；selection 固定编排与 draft/published/version 身份，path 和 expected_sha256 使用目录回执。仅读实际文件，不执行。'],
    ['compositionRun', 'run_id'], ['compositionArtifact', 'run_id artifactId'], ['seedThreatCompositions', 'revision bindings', '仅在业务扩展实际装载且用户要求时使用。'],
    ['control/status', '', '读取基础许可、风险事实、限制与真实实例回执；定时任务不在首期覆盖范围。'],
    ['control/saveConfiguration', 'revision enabled agents', '使用 control/status 的字符串 revision 和当前 agents 规则；只修改开放与基础授权，不发送凭据。'],
    ['control/restrict', 'scope deniedActions reason', 'scope 至少指定 workspaceId、agentId、subjectId；使用已登记实例及主体，动作 read/write/publish。'],
    ['control/reassess', 'sessionId action', '重新评估当前 Session 的指定动作；不会执行或重放业务。'],
    ['control/release', 'restrictionId sessionId action', '重新评估后仅解除所选限制，其他约束保留；未知副作用先查实际结果，不能以恢复操作补发业务。'],
  ],
  agents: [
    ['migrations/inspect', 'source', 'source 为来源描述对象：本地目录、Git 仓库、归档或文本材料。固定来源后仅清点，不执行来源脚本；本地/归档用path，Git用url/ref，文本用text/filename；沿返回的 source_id 和 fingerprint 读取。模型绑定先读取 platform_agents context 的 model_catalog，使用实际业务 provider/model 与 reasoning 档位，不读取内部运行配置猜测。'],
    ['migrations/read', 'source_id fingerprint path offset limit', '使用 inspect 返回的真实来源身份和路径；文本按回执继续读取，二进制仅返回摘要等元信息。'],
    ['migrations/preview', 'source_id fingerprint target files mapping case_ids evaluation_cases model_bindings project_workspace role_instructions uncovered scope_limitations', '先完整清点关键引用，再提交目标与完整资产修改。target.kind=new-agent 或 new-version；既有 Agent 使用明确的可继承 EXP 和固定 Git 来源。case_ids 引用已有代表 Case，evaluation_cases 追加新 Case，两者合并验证。uncovered 只列待实现的关键来源行为；未做原框架A/B、固定来源样例未使用的框架能力放 scope_limitations，框架包被DSH替代等非目标资产用 omitted、required:false准确标明。files 使用正文或固定 source_path；返回固定目标和 operation_id、preview_sha256，不表示已迁移完成。'],
    ['migrations/apply', 'operation_id expected_preview_sha256', '原样使用 preview 的 apply_input；中断或结果未知先查 migrations/status，沿同一 operation_id 续作，不另建目标。'],
    ['migrations/status', 'operation_id experiment_id', '读取迁移目标、发布、构建、实例及 Run 的真实进度；资产变化后旧验证不代表当前版本通过。'],
    ['migrations/resolve', 'operation_id experiment_id expected_candidate_sha256 resolutions', '在原迁移版本核对待办，用当前Candidate摘要和resolutions提交依据。沿status.unresolved_items原索引提供mapping_index或uncovered_index之一、notes和实际case_ids。disposition=converted（默认）表示已转换，native表示已由原生能力承接，可带target；outside-scope仅处理当前明确范围之外的限制，不能改source/target或声称已实现，保留原状态并由status.scope_limitations单列。不得将遗漏的关键来源行为排除出用户目标。原关键Case和解决项Case仍须由当前真实Run全部通过。结果未知先查status，同一来源不重复创建版本。'],
    ['assets/build-preview assets/build', 'experiment_id entry_path expected_candidate_sha256 expected_preview_sha256', '普通业务 EXP 的 Managed TypeScript 受控构建。先预览，执行使用返回的候选与预览摘要；不执行来源 package scripts。'],
    ['assets/dependencies/prepare', 'experiment_id target_image target_platform declaration_paths', '从实际 Candidate 的锁定依赖声明自动准备标准 Runtime 依赖；declaration_paths 可选，用于核对完整发现清单，不用于跳过部分依赖。target_image 只接受当前标准镜像，target_platform=linux/amd64 或 linux/arm64。不执行来源安装 Hook；回执明确目标环境、准备结果与缺口，不代表业务通过。'],
    ['list', ''], ['detail', 'agent_id experiment_id', '明确指定版本；未传 experiment_id 时 detail.experiment 优先是已启用版本，用户要求最新版本时应读取 versions[0].id。有固定任务目标时不要改成最新版本。'],
    ['documents/read', 'path cursor limit source_sha256', '只读当前数据工作区文档或当前会话附件。path 使用工作区相对路径或模型输入中原生附件 read_path；不传 Session ID。支持 Markdown/TXT、文本 PDF、DOCX。按 blocks 的页/段号及片段偏移引用来源；has_more=true 时用 next_cursor 与 source_sha256 连续读取，不能将首段当作全文。扫描件、图片及复杂排版以 warnings 为准；不执行文件，也不创建知识资产。'],
    ['research/read-reference', 'topic', 'topic=controlled-improvement/evaluation-and-evidence/inheritance-and-fusion/compute-variants/decision-samples。'],
    ['research/validate', 'experiment_id'], ['legacy/inspect', 'path', '仅检查 data evolution/history/imports 内的既有材料，不执行旧代码。'],
    ['new', 'agent_id name description role evaluation_cases profile', '先查 tasks/capabilities 复用已有能力；evaluation_cases 使用实际业务测试，ID 以 U- 开头（如 U-CHAT-GREET），身份测试由平台创建。'],
    ['sdk/start', 'source instance_id input session_id request_id', '启动同容器官方 TypeScript SDK 调试。request_id 固定，重试必须保持同一请求；刷新只用 sdk/status 查询，不重放输入。'],
    ['sdk/status sdk/stop', 'operation_id', '停止会关闭本次 Runtime，保留 HOME；结果未知时核对原实例，不自动重跑。'],
    ['sdk/list sdk/guide', 'source', '读取当前来源的调试记录或唯一 SDK 接入文档和 TypeScript 示例。'],
    ['create', 'agent_id parent_experiment_id parent_ref research_question', 'parent_ref 使用固定 git:<40位commit>；创建版本不表示已融合验证。'],
    ['edit/read', 'experiment_id path'], ['edit/preview edit/apply', 'experiment_id edits', '先 edit/read，每次提交实际文件正文和原摘要；写入遵循 DSH 原生权限与当前任务范围。'],
    ['assets/diff', 'experiment_id path against baseline_experiment_id', '先省略 path 列差异，再用返回的 path 读完整差异；against=baseline 或指定比较方式。'], ['assets/read-fixed', 'agent_id experiment_id ref path', 'ref 必须为固定 git:<40位commit>；省略 path 可先列目录。'],
    ['cases/list cases/create-context', 'agent_id experiment_id'], ['cases/read', 'agent_id experiment_id case_id'],
    ['cases/from-run', 'agent_id experiment_id run_id case_id'],
    ['cases/update cases/create-preview cases/create', 'agent_id experiment_id case_id title scene inputs expected_behavior fast expected_sha256 source_run_id source_case_id', '先读用例或 create-context；inputs 为非空字符串数组，expected_sha256 取原文件摘要。新建先 create-preview。'],
    ['eval/preview eval/start', 'source cases mode executor review model model_selection compare_to artifact_export', 'source=experiment:<ID>；cases 为固定 Case ID 数组。model 是原有断言，model_selection 是本次主角色原生模型选择；省略时读取版本绑定。preview 不执行评测，start 返回 job_id。'],
    ['eval/status eval/cancel', 'job_id'], ['runs/index', 'agent_id experiment_id'],
    ['runs/show', 'run_id case_id'], ['runs/report runs/files', 'run_id'], ['runs/read-file', 'run_id path'],
    ['runs/evidence', 'run_id case_id filename'], ['runs/compare', 'left right case_id'], ['runs/trace', 'run_id path source_sha256 cursor limit session_log'],
    ['decision/preview decision/update', 'experiment_id content expected_sha256 status outcome expected_change_sha256', 'expected_sha256 原样使用 detail.decision.sha256；缺文件为 null，已有空文件仍为实际摘要。修改 status/outcome 时还须 detail 返回的 change 摘要；status=active/completed，outcome=adopt/continue/reject/inconclusive。'],
    ['features/read-source', 'experiment_id ref', '先省略 ref 获取来源文件，再逐个读取。'],
    ['features/preview', 'experiment_id features', '固定目标特性整理任务自动保存并回读；保留证据和未验证边界，不需人工确认。'],
    ['features/proposal', 'experiment_id'], ['features/apply fusion/confirm datasets/apply', 'preview_id', '此操作由既有确认或固定目标专项保存流程办理；不要绕过原预览身份。'],
    ['fusion/preview', 'agent_id parent_experiment_id parent_ref research_question plan', '先省略 plan 读取 inventory。融合 plan={sources:[{experiment_id,ref,decision:inherit/omit,reason}],features,conflicts:[{description,resolution}],checks:[{id,kind:build/load/capability,command?,cwd?,case_ids?}],evaluation_case_ids,evaluation_sha256}；来源和评测摘要使用实际读取值。'],
    ['fusion/proposal', 'agent_id parent_experiment_id'], ['fusion/status fusion/finalize', 'experiment_id'],
    ['fusion/verify', 'experiment_id expected_candidate_sha256 check_id run_id'],
    ['datasets/source', 'run_id path source_sha256 source_identity_sha256 cursor limit decision_id content_sha256', `所有续读保留source_sha256与完整source_identity_sha256；指定path后不重复目录。大决策按read_input读取fragment，另保留content_sha256并完整拼接；来源Agent/版本/Run及Candidate/dirty由服务器固定。${DECISION_EXTRACTION_CONTRACT.source.limits}分片回执的read_input非空时直接用它续读，不扩大limit。`],
    ['datasets/preview', 'run_id path source_sha256 source_identity_sha256 samples skipped', '遵循 datasets/source 的 extraction_contract；可携来源页的完整身份摘要防止读取后改绑。固定 Run 专项自动保存并回读，样本仍为 suggested。'],
    ['datasets/list', 'run_id'], ['datasets/read', 'dataset_id'],
    ['datasets/review', 'dataset_id expected_sha256 record_id workflow task questions targets group_id split', 'AI 委托逐题复核，用于 functional_validation。先读取真实批次及完整决策前输入；大回执的 state_omitted 需按 read_input 调 datasets/source 完整续读后再判断。可同次修改题目与标签。每题 targets 只提供 label、basis、可选 probabilities、status(reviewed/rejected)、decision_time_reviewed；不提交 provenance、review、Session、模型或时间。身份及完整输入读取证据由真实会话记录；必须在读完后下一轮模型请求中判断，不能同一步并发读取与复核。不冒称人工或独立真值；没有概率证据时省略。保留原 group_id/split，除非用户已授权用途调整。'],
    ['datasets/export', 'dataset_id mode', 'mode=candidates/training/development/calibration/test。candidates 可导出候选，其余仅导出符合对应用途且已逐题复核的题目；保留实际复核方式，AI 委托复核用于功能验证，不等同人工或独立真值。'],
    ['compute-variants/identity-preview', 'experiment_id current_variant_id', '将存量 EXP 算力变体迁移到当前 VAR 身份；省略 current_variant_id 由平台分配新 VAR，明确关联已有 VAR 时须同 Agent、固定业务父版和研究任务。预览不会写入。'],
    ['compute-variants/identity-apply', 'experiment_id current_variant_id expected_preview_sha256', '使用 identity-preview 返回的 apply_input 原样执行。只在旧 change.yaml 保存 current_variant_id；已有 VAR 的当前资产不覆盖，历史 Run/Git/Session 不改、不充作新 Run。结果未知时先回读 detail/current_variant_id，重复执行只返回已完成映射；无需额外人工确认。'],
    ['compute-variants/source', 'experiment_id path expected_sha256', '省略 path 列实际生成文件目录；读取时使用目录返回的 path 和 sha256（expected_sha256），源码只读，不执行。'],
    ['compute-variants/context', 'experiment_id', '先读取 generation_contract 和固定父版；不凭空编造 SDK 能力。'],
    ['compute-variants/preview compute-variants/create', 'agent_id parent_experiment_id parent_ref variant_name strategy case_ids critical_case_ids min_runs_per_case max_pass_rate_drop_pp resource_metric min_resource_reduction_pct allow_model_change variant_model variant_reasoning_effort execution_mode model_roles generation', '使用 context 返回的生成合同；名称与策略分别提供。hybrid 双模型身份与单模型变更互斥。'],
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
  if (action === 'sdk/start') properties.input = { type: 'string', description: '本次真实调试输入。' }
  if (action === 'documents/read') {
    properties.cursor = { type: 'string', description: '上一次回执的 next_cursor，绑定原文件摘要与位置。' }
    properties.limit = { type: 'integer', description: '本次最多返回的正文字符数，512–32768，默认16000。' }
  }
  if (action === 'decision/preview' || action === 'decision/update') properties.expected_sha256 = { type: ['string', 'null'], description: 'detail.decision.sha256；缺文件为 null，已有空文件使用返回的实际摘要。' }
  if (action === 'migrations/inspect') properties.source = { type: 'object', required: ['kind'], properties: {
    kind: { type: 'string', enum: ['local', 'git', 'archive', 'text'] }, path: { ...string, description: 'local/archive 使用本机绝对路径，git 也可用本地仓库路径。' },
    url: { ...string, description: 'git 远程仓库地址，不能包含凭据。' }, ref: { ...string, description: 'git 分支或提交，服务端固定实际提交；省略为 HEAD。' },
    text: { ...string, description: 'text 来源的完整材料。' }, filename: { ...string, description: 'text 来源的相对文件名，省略为 source.txt。' },
  } }
  if (action === 'migrations/preview') {
    properties.scope_limitations = { ...strings, description: '本次明确范围边界，如默认未执行原框架A/B、固定来源样例未使用的框架能力；不替代关键来源行为的 uncovered。' }
    properties.target = { type: 'object', required: ['kind', 'agent_id'], properties: {
      kind: { type: 'string', enum: ['new-agent', 'new-version'] }, agent_id: string,
      name: { ...string, description: 'new-agent 必填名称。' }, description: { ...string, description: 'new-agent 必填用途。' }, role: { ...string, description: 'new-agent 必填角色正文。' },
      parent_experiment_id: { ...string, description: 'new-version 必填可继承普通 EXP。' }, parent_ref: { ...string, description: 'new-version 必填固定 git:<40位提交>。' }, research_question: { ...string, description: 'new-version 必填本次迁移的业务问题。' },
    } }
    properties.files = { type: 'array', items: { type: 'object', required: ['path'], properties: {
      path: { ...string, description: '相对 Candidate；harness.yaml 或 dsh/workspace、dsh/presets、dsh/managed 内文件。' },
      content: { ...string, description: '完整 UTF-8 正文，与 source_path 二选一。' }, source_path: { ...string, description: '本次来源清点 entries[].path 的 POSIX 相对路径，例如 version_tool.py；不能使用绝对路径，与 content 二选一。' },
      source_sha256: { ...string, description: '复制来源文件时必须使用清点返回的摘要。' }, executable: { type: 'boolean' },
    } } }
    properties.mapping = { type: 'array', items: { type: 'object', required: ['source', 'target', 'status'], properties: {
      source: string, target: string, status: { type: 'string', enum: ['converted', 'native', 'pending', 'omitted'] }, notes: string, required: { type: 'boolean' },
    } } }
    properties.model_bindings = { type: 'object', required: ['main'], properties: { main: fields.model_selection, presets: { type: 'object', additionalProperties: fields.model_selection } } }
    properties.project_workspace = { type: 'object', required: ['path'], properties: { path: { ...string, description: 'Candidate 内已选入的项目种子目录，如 dsh/workspace/project。' } } }
    properties.role_instructions = { type: 'object', additionalProperties: string, description: 'Preset ID 到 Candidate 内角色文件的映射；主角色默认指向 dsh/workspace/AGENTS.md。' }
  }
  if (action === 'migrations/resolve') properties.resolutions = { type: 'array', items: { type: 'object', required: ['notes', 'case_ids'], properties: {
    mapping_index: { type: 'integer', description: 'status.unresolved_items返回的原mapping索引，与uncovered_index二选一。' }, uncovered_index: { type: 'integer', description: 'status.unresolved_items返回的原uncovered索引，与mapping_index二选一。' },
    disposition: { type: 'string', enum: ['converted', 'native', 'outside-scope'], description: '省略为converted；outside-scope只说明当前明确范围，不表示实现，不允许提供target，仍须保留真实Case依据。' }, target: string, notes: string, case_ids: strings,
  } } }
  return { domain, action, input_schema: { type: 'object', properties, additionalProperties: true },
    instructions: hint[2] ?? '使用先前实际返回的对象标识；缺少目标先查询目录。输入由原业务接口校验，错误时核对具体字段，不重放结果未知的写操作。' }
}

/** DSH 只接收有限 JSON Schema；数值和长度约束保留为说明，实际 Zod 解析不变。 */
function nativeSchema(schema: MapValue): MapValue {
  const result: MapValue = {}
  const constraints: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, nativeSchema(child as MapValue)]))
    else if (key === 'additionalProperties' && typeof value === 'object') { result.additionalProperties = true; constraints.push(`动态属性的值合同=${JSON.stringify(value)}`) }
    else if (key === 'items' && typeof value === 'object') result[key] = nativeSchema(value)
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
