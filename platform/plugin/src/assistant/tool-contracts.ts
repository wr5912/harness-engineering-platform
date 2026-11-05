import { z } from 'zod'
import { businessCasesSchema } from '../agents/business-cases.ts'
import { DECISION_EXTRACTION_CONTRACT } from '../evaluation/decision-dataset-contract.ts'
import { isComputeVariantExecution } from './extraction-scope.ts'

export type AssistantDomain = 'agents' | 'instances' | 'mcp'
type MapValue = Record<string, any>
const migrationActions = ['migrations/inspect', 'migrations/read', 'migrations/preview', 'migrations/apply', 'migrations/status', 'migrations/resolve', 'assets/build-preview', 'assets/build', 'assets/dependencies/prepare']
export const assistantActions: Record<AssistantDomain, readonly string[]> = {
  agents: ['sdk/start', 'sdk/status', 'sdk/stop', 'sdk/list', 'sdk/guide', ...migrationActions, 'versions/migration-plan', 'versions/migration-apply', 'documents/read', 'research/read-reference', 'research/validate', 'legacy/inspect', 'decision/preview', 'list', 'detail', 'edit/read', 'edit/preview', 'edit/apply', 'cases/list', 'cases/read', 'cases/update', 'cases/delete', 'eval/preview', 'eval/start', 'eval/batch-start', 'eval/status', 'eval/cancel', 'runs/index', 'runs/delete', 'runs/show', 'runs/evidence', 'runs/report', 'runs/files', 'runs/read-file', 'runs/compare', 'runs/trace', 'assets/diff', 'assets/read-fixed', 'compute-variants/context', 'compute-variants/source', 'compute-variants/identity-preview', 'compute-variants/identity-apply', 'compute-variants/preview', 'compute-variants/create', 'compute-variants/rename', 'compute-variants/plan-preview', 'compute-variants/plan-apply', 'compute-variants/prepare', 'compute-variants/build-preview', 'compute-variants/build', 'compute-variants/freeze-preview', 'compute-variants/freeze', 'compute-variants/compare', 'new', 'create', 'cases/create-context', 'cases/from-run', 'cases/create-preview', 'cases/create', 'datasets/source', 'datasets/preview', 'datasets/apply', 'datasets/list', 'datasets/read', 'datasets/review', 'datasets/export', 'decision/update', 'features/read-source', 'features/preview', 'features/proposal', 'features/apply', 'fusion/preview', 'fusion/prepare', 'fusion/resolve', 'fusion/recover', 'fusion/proposal', 'fusion/confirm', 'fusion/status', 'fusion/verify', 'fusion/finalize', 'tasks/capabilities', 'tasks/assembly-preview', 'tasks/assembly-apply'],
  instances: ['list', 'detail', 'url', 'logs', 'preview', 'batch-preview', 'run', 'batch'],
  mcp: ['list', 'configuration', 'saveConfiguration', 'test', 'resources', 'resourceTemplates', 'readResource', 'callTool', 'sources/list', 'sources/create', 'sources/refresh', 'sources/toggle', 'sources/components', 'sources/logs', 'sources/preview', 'sources/invoke', 'saveCompositionDraft', 'publishComposition', 'executeComposition', 'dryRunComposition', 'callPublishedComposition', 'compositionRun', 'compositionArtifact', 'compositionSource', 'seedThreatCompositions', 'control/status', 'control/saveConfiguration', 'control/restrict', 'control/reassess', 'control/release'],
}

export const featureActions = ['research/read-reference', 'detail', 'edit/read', 'assets/diff', 'assets/read-fixed', 'features/read-source', 'features/preview', 'features/proposal', 'runs/index', 'runs/show', 'runs/report', 'runs/files', 'runs/read-file', 'runs/trace']
export function allowedAssistantActions(domain: AssistantDomain, state: any): readonly string[] {
  const context = state?.task_context ?? {}
  if (context.skill === 'decision-sample-extraction') return domain === 'agents' ? ['research/read-reference', 'datasets/source', 'datasets/preview', 'datasets/list'] : []
  if (context.skill === 'agent-maintenance' && context.workflow === 'features') return domain === 'agents' ? featureActions : []
  if (context.skill === 'compute-variant-research') return domain === 'agents'
    ? assistantActions.agents.filter(action => /^(compute-variants\/|research\/|assets\/|edit\/|eval\/|runs\/|decision\/|cases\/)/.test(action) || isComputeVariantExecution(state) && action.startsWith('datasets/') || ['list', 'detail', 'tasks/capabilities'].includes(action)) : isComputeVariantExecution(state) ? assistantActions[domain] : []
  return assistantActions[domain]
}

const string = { type: 'string' }, strings = { type: 'array', items: string }, object = { type: 'object', additionalProperties: true }
const fields: MapValue = {
  training_files: { type: 'array', items: { type: 'object', required: ['path', 'sha256'], additionalProperties: false, properties: { path: string, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }, description: 'prepare 归档的补充训练依赖，如模型配置、tokenizer 和状态构造器资源；逐文件核对摘要并保持原相对目录，不复制缓存或整个目录。已归档依赖随后从回执复用。' },
  version_number: { type: 'integer', minimum: 1, maximum: 999, description: '可选编号；启用 m/f 后只能等于当前代，创建同代 f 特性副本。省略时仍保留当前代；下一代 m 只能由用户明确 create_next_generation 创建，先处置未合并特性。随机后缀由平台生成。' },
  version_role: { type: 'string', enum: ['m', 'f'], description: '同一 Agent、同一版本号只允许一个 m，可有多个 f；同号副本为 f，明确创建下一代为 m。不同后缀不能用于额外创建 m。' },
  create_next_generation: { type: 'boolean', description: '仅用户明确要求创建下一代时为 true，不因融合或采纳自动设置。' },
  feature_dispositions: { type: 'array', items: { type: 'object', required: ['experiment_id', 'decision', 'reason'], properties: { experiment_id: string, decision: { type: 'string', enum: ['defer', 'reject'] }, reason: string } } },
  source_ref: { type: 'string', pattern: '^git:[a-f0-9]{40}$', description: '可选固定来源；Candidate、Case、角色绑定均读取同一 Git 提交，Run 仍保存到原版本。' },
  evaluation_source: { type: 'string', enum: ['source', 'current'], description: '默认 source 沿用所选来源的 Case；current 明确用当前工作区 Case 评测固定 Candidate，所选口径随 Run 冻结。' },
  mcp_fixture: { type: 'object', required: ['schema_version', 'mode', 'connections'], additionalProperties: false, properties: {
    schema_version: { type: 'integer', const: 1 }, mode: { type: 'string', const: 'mock' }, connections: { type: 'array', minItems: 1, items: {
      type: 'object', required: ['server_id', 'original_url', 'url'], additionalProperties: false,
      properties: { server_id: string, original_url: string, url: string, enabled: { type: 'boolean' } },
    } },
  }, description: '显式 Mock 连接映射，只投影本次评测 Runtime。原地址必须精确匹配所选来源；保留工具公开名，禁止凭据字段。两侧比较使用相同映射字节。' },
  target: object, mapping: { type: 'array', items: object }, uncovered: strings, offset: { type: 'integer' }, model_bindings: object, project_workspace: object, role_instructions: object,
  resolutions: { type: 'array', items: object },
  declaration_paths: strings, target_platform: string, target_image: string, fingerprint: string,
  model_selection: { type: 'object', required: ['provider', 'model'], properties: { provider: string, model: string, reasoningEffort: string }, description: '原生模型选择，覆盖本次主角色选择；未传时使用指定版本绑定，再回落业务默认。' },
  profile: { type: 'string', enum: ['web', 'sdk'], description: '使用方式，默认web；sdk为同容器官方TypeScript SDK调用。' },
  case_ids: strings, critical_case_ids: strings, cases: strings, inputs: strings, artifacts: strings, parent_run_ids: strings, variant_run_ids: strings, run_ids: strings,
  fast: { type: 'boolean' }, enabled: { type: 'boolean' }, allow_missing_env: { type: 'boolean' },
  business_control: { type: 'boolean', description: '创建业务实例默认且必须经过统一网关；不能用 false 绕过网关。已有实例的生命周期沿用其登记。' },
  access_mode: { type: 'string', enum: ['authenticated', 'anonymous'], description: '业务实例访问方式；anonymous 为无需登录的局域网匿名访问。' },
  identity_mode: { type: 'string', enum: ['development', 'published'], description: '业务实例身份验证阶段。' },
  min_runs_per_case: { type: 'integer' }, max_pass_rate_drop_pp: { type: 'number' }, min_resource_reduction_pct: { type: 'number' }, allow_model_change: { type: 'boolean' }, generation: object,
  execution_mode: { type: 'string', enum: ['code-only', 'hybrid'] },
  model_roles: { ...object, description: 'hybrid 必填 {language,decision}；每项 provider/model/reasoning_effort，decision 另需 checkpoint_sha256/state_constructor_sha256/calibration_sha256。使用 generation_contract。' },
  decision_training: { ...object, description: '中算力真实训练回执 {path,sha256}；按 generation_contract.decision_training 回收数据、日志与工件。缺失时不认定训练完成或具备 end 条件。' },
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
    properties: { path: string, move_to: { ...string, description: '可选：将 path 移动到同一 Candidate 内尚不存在的文件路径，同时保存 content；摘要仍取源文件，目标须先读取为不存在。' }, content: { type: ['string', 'null'], description: '修改后完整文件正文，不能省略或只提供补丁；null 表示删除当前 Candidate 内单个文件，须有原摘要，不能同时 move_to。空字符串仍表示保存空文件。' }, expected_sha256: { type: ['string', 'null'], description: 'edit/read 返回的原始摘要；新文件为 null，删除必须是现有文件的摘要。' } } } },
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
    ['preview run', 'name operation source port allow_missing_env business_control access_mode identity_mode model_selection', 'operation=create/start/stop/restart/reload/delete；reload 只重载运行中实例，内部先预览并绑定资产和运行代次摘要，保留 HOME、会话、端口、模型和网关身份，核验实际加载回执；批量逐项返回结果，不自动重放失败或未知写请求；创建必须传明确的 experiment:<ID> 来源。创建业务实例默认且必须经过统一网关，默认 access_mode=anonymous、identity_mode=development；可明确选择 authenticated 或 published。网关不可用时说明原因并修复配置，禁止省略参数或传 false 改为直连。独立研究评测使用 agents/eval 入口，不用业务实例创建接口绕过网关。用户要求最新版本时，先用 agents/detail 的 versions[0].id 确定版本，再作为 source 传入；默认 detail.experiment 可能是已启用版本，不等于最新版本。直接调用 run 即可由平台内部预览并核对模型、业务来源摘要与访问设置，按 DSH 原生权限执行；无需另调 preview 或额外索取确认。业务实例创建后用 instances/url 取统一网关入口，不要把容器直连端口当作业务链接。'],
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
    ['list', ''], ['detail', 'agent_id experiment_id', '明确指定版本；未传 experiment_id 时优先最新主线 version_governance.mainline_id；agent.manifest.active_experiment 是已启用版本，实例实际加载另查实例。有固定任务目标时不要改成最新版本。'],
    ['documents/read', 'path cursor limit source_sha256', '只读当前数据工作区文档或当前会话附件。path 使用工作区相对路径或模型输入中原生附件 read_path；不传 Session ID。支持 Markdown/TXT、文本 PDF、DOCX。按 blocks 的页/段号及片段偏移引用来源；has_more=true 时用 next_cursor 与 source_sha256 连续读取，不能将首段当作全文。扫描件、图片及复杂排版以 warnings 为准；不执行文件，也不创建知识资产。'],
    ['research/read-reference', 'topic', 'topic=controlled-improvement/evaluation-and-evidence/inheritance-and-fusion/compute-variants/decision-samples。'],
    ['research/validate', 'experiment_id'], ['legacy/inspect', 'path', '仅检查 data evolution/history/imports 内的既有材料，不执行旧代码。'],
    ['new', 'agent_id name description role evaluation_cases profile', '先查 tasks/capabilities 复用已有能力；evaluation_cases 使用实际业务测试，ID 以 U- 开头（如 U-CHAT-GREET），身份测试由平台创建；inputs 为单轮字符串或按轮次排列的字符串数组，多行文字不等于多轮。'],
    ['sdk/start', 'source instance_id input session_id request_id', '启动同容器官方 TypeScript SDK 调试。request_id 固定，重试必须保持同一请求；刷新只用 sdk/status 查询，不重放输入。'],
    ['sdk/status sdk/stop', 'operation_id', '停止会关闭本次 Runtime，保留 HOME；结果未知时核对原实例，不自动重跑。'],
    ['sdk/list sdk/guide', 'source', 'source 必须指向 SDK 型版本，返回该版本的调试记录或业务集成用 TypeScript 调用示例与接入说明。开发 DSH 插件和工具时，读取锁定 Runtime 的插件与工具公开合同。'],
    ['create', 'agent_id parent_experiment_id parent_ref research_question version_number version_role create_next_generation feature_dispositions expected_governance_sha256', 'parent_ref 使用固定 git:<40位commit>，从同一提交完整继承 Candidate；启用 m/f 后默认同代 f，历史版本也可派生。只有用户明确创建下一代才传 create_next_generation:true，从当前 m 派生并逐项填写未合并特性的 defer/reject 和原因；最新代 m/f 均可编辑，历史代只读。'],
    ['edit/read', 'experiment_id path'], ['edit/preview edit/apply', 'experiment_id edits', '先 edit/read，每次提交实际文件正文和原摘要；可用 edits[].move_to 在同一 Candidate 内移动文件到已读取确认不存在的路径，同批更新引用，目标已存在时拒绝覆盖。content:null 按原摘要删除当前 Candidate 内单个文件，不递归删除目录；空字符串保存空文件。写入遵循 DSH 原生权限与当前任务范围。'],
    ['assets/diff', 'experiment_id path against baseline_experiment_id', '先省略 path 列差异，再用返回的 path 读完整差异；against=baseline 或指定比较方式。'], ['assets/read-fixed', 'agent_id experiment_id ref path', 'ref 必须为固定 git:<40位commit>；省略 path 可先列目录。'],
    ['cases/list cases/create-context', 'agent_id experiment_id'], ['cases/read', 'agent_id experiment_id case_id'],
    ['cases/delete', 'experiment_id case_id expected_sha256', '先 cases/read 核对用例及原摘要。删除当前共用用例，至少保留一个；历史 Run 冻结口径与结果不变。写入沿用版本治理及摘要校验。'],
    ['cases/from-run', 'agent_id experiment_id run_id case_id'],
    ['cases/update cases/create-preview cases/create', 'agent_id experiment_id case_id title scene inputs expected_behavior fast expected_sha256 source_run_id source_case_id', '先读用例或 create-context，并按 evaluation-review 核对共用业务口径；预期写业务过程与结果模式，使用已核验 API 名称、operationId 或中文能力名，不绑定 MCP 运行时 ID、KEV 等实现路线或特定环境。inputs 为非空字符串数组，expected_sha256 取原文件摘要。新建先 create-preview。'],
    ['eval/preview eval/start', 'source source_ref evaluation_source mcp_fixture cases mode executor review model model_selection compare_to artifact_export concurrency parallel_cases program_root', 'source=experiment:<ID>；cases 为固定 Case ID 数组。source_ref 可固定历史来源；evaluation_source=current 明确改用当前 Case，不改变固定 Candidate。program_root 可指定已构建的隔离程序根，沿用平台模型投影和凭据注入；程序来源由 Run 如实封存。mcp_fixture 明确 Mock 边界并随 Run 封存，不修改原连接或 Candidate，不代表真实业务系统验收。model 是原有断言，model_selection 是本次主角色原生模型选择；省略时读取所选来源的版本绑定。preview 不执行评测，返回唯一预留 run_id。start 必须携带该 run_id 与相同参数，真实 Run 创建后返回同一编号。刷新、断线和旧请求恢复只能 status 查询；不存在或过期时重新 preview，不能重发原启动。旧 Skill 的 job_id 为旧输入名，以当前合同及真实回执为准。'],
    ['eval/batch-start', 'requests', '先逐项preview取得不同的run_id，每项固定source_ref和原参数，再启动1–8个独立Run；整批核对预留，按序创建，失败即停止未开始项。返回runs、failed和not_started；已创建Run不回滚。断线只逐项status查询，不自动重发整批；失败或未开始项须重新preview。'],
    ['eval/status eval/cancel', 'run_id', '使用预览及启动返回的同一Run ID。status也查询尚未启动或正在创建的预留；cancel可撤销未消费预留。旧job_id输入仅兼容查询原运行或取消原对象，不创建新评测。'], ['runs/index', 'agent_id experiment_id'],
    ['runs/delete', 'run_ids', '永久删除指定评测的结果、报告和证据，仅允许已结束且进程已退出的 Run；逐条返回 deleted 与 failed，部分失败只重试失败项。删除前核对用户指定的记录及范围。结果未知时先 runs/index 查询，不自动重放。'],
    ['runs/show', 'run_id case_id'], ['runs/report runs/files', 'run_id'], ['runs/read-file', 'run_id path'],
    ['runs/evidence', 'run_id case_id filename'], ['runs/compare', 'left right case_id'], ['runs/trace', 'run_id path source_sha256 cursor limit session_log'],
    ['decision/preview decision/update', 'experiment_id content expected_sha256 status outcome expected_change_sha256', 'expected_sha256 原样使用 detail.decision.sha256；缺文件为 null，已有空文件仍为实际摘要。修改 status/outcome 时还须 detail 返回的 change 摘要；status=active/completed，outcome=adopt/continue/reject/inconclusive。'],
    ['features/read-source', 'experiment_id ref', '先省略 ref 获取来源文件，再逐个读取。'],
    ['features/preview', 'experiment_id features', '固定目标特性整理任务自动保存并回读；保留证据和未验证边界，不需人工确认。'],
    ['features/proposal', 'experiment_id'], ['features/apply datasets/apply', 'preview_id', '此操作由既有确认或固定目标专项保存流程办理；不要绕过原预览身份。'],
    ['versions/migration-plan', '', '盘点 security-operations-expert 的 027 身份，仅迁移当前完整且已固定的资产；返回缺失、残片、已迁移及阻塞项、引用字段、实例依赖和 plan_sha256，不改真实数据。'],
    ['versions/migration-apply', 'expected_plan_sha256 confirmed', '仅明确授权迁移时执行，使用最新 plan_sha256；依赖须先解除，历史 Run 和归档原文不改写。'],
    ['fusion/preview', 'agent_id parent_experiment_id parent_ref target_experiment_id research_question plan', '合并特性时 target_experiment_id 必须为同号现有 m，parent 为 f。先省略 plan 读取 inventory 和实际差异；新流程用 fusion/prepare 自动生成字节草稿，仅冲突经 fusion/resolve；旧 plan.edits 仍须包含实际修改及原摘要。合并 m 需要 build/load/capability 三类独立验证。融合 plan={sources:[{experiment_id,ref,decision:inherit/omit,reason}],features,conflicts:[{description,resolution}],checks:[{id,kind:build/load/capability,command?,cwd?,case_ids?}],evaluation_case_ids,evaluation_sha256}；command 是 argv 数组，如 ["node","--check","candidate/plugin.mjs"]，不经过 shell，不能把整行命令作为一个数组元素；来源和评测摘要使用实际读取值。'],
    ['fusion/proposal', 'agent_id parent_experiment_id'], ['fusion/status', 'experiment_id operation_id', '有 operation_id 时查询同一持久草稿、冲突、写入状态和恢复建议；否则查询目标版本验证状态。'],
    ['fusion/prepare', 'agent_id parent_experiment_id parent_ref target_experiment_id research_question plan', '先只读 preview 判断来源取舍，再 prepare 保存持久草稿。复用同一完整 plan（无需 edits），Git 自动合并固定来源和实际目标工作树。返回 operation_id、plan_sha256、冲突与可供 Beyond Compare 使用的快照包；不写 Candidate。'],
    ['fusion/resolve', 'operation_id expected_plan_sha256 resolutions', 'resolutions=[{path,decision:source/target/delete/content/result,reason,content?,expected_result_sha256?,mode?}]。仅提交冲突或明确要覆盖自动取舍的文件；result 只导入本操作 result 目录中的已知路径，必须提供输出摘要。保留目标用 target，删除用 delete；返回新的 plan_sha256。不要让模型往返纯复制文件全文。'],
    ['fusion/confirm', 'preview_id operation_id expected_plan_sha256 confirmed', '原生草稿传 operation_id、最新 expected_plan_sha256、confirmed=true；旧流程传 preview_id。重复确认返回同一已保存回执。结果未知先 status，不重建或重放。'],
    ['fusion/recover', 'operation_id expected_plan_sha256 confirmed recovery', '仅对中断操作恢复；recovery=rollback 只恢复仍与本次输出匹配的文件，存在并行修改则拒绝；complete 仅在全部文件、执行位与元数据均为预期输出时补记完成。先 status 核对，不自动重放。'],
    ['fusion/finalize', 'experiment_id expected_candidate_sha256 cleanup_features confirmed', '完成前读取 fusion/status 的当前 Candidate 摘要；构建、装载与能力回执须对应同一摘要及评测口径。完成同号 m 的融合只返回该 m 的 mainline_id，不生成下一代，不借用 f 的 Run 或结论。验收后明确传 cleanup_features=true、confirmed=true 清理对应 f 的当前 Candidate；须先解除实例与启用依赖，核对固定源码摘要，保留 Run、工件和历史原文。'],
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
    ['compute-variants/preview compute-variants/create', 'agent_id parent_experiment_id parent_ref variant_name strategy case_ids critical_case_ids min_runs_per_case max_pass_rate_drop_pp resource_metric min_resource_reduction_pct allow_model_change variant_model variant_reasoning_effort execution_mode model_roles decision_training generation', '使用 context 返回的生成合同；名称与策略分别提供。hybrid 双模型身份与单模型变更互斥。'],
    ['compute-variants/rename', 'experiment_id variant_name expected_change_sha256'],
    ['compute-variants/plan-preview compute-variants/plan-apply', 'experiment_id case_ids expected_change_sha256 expected_preview_sha256', '共享用例修订后重新确认已有探索性变体计划；保留全部原 Case，可明确新增 Case，不改变父版、训练、模型及质量和资源阈值。apply 传真实预览的两个摘要，随后重新冻结并执行新 Run；保留历史 Run。'],
    ['compute-variants/prepare', 'experiment_id entry_path case_ids training_files', '先核验并归档已完成的混合变体训练引用闭包到所属 Experiment/evaluation，更新计划引用，再核对或构建代码并本地冻结；返回固定source_ref和各步复用情况。training_files 补充模型配置与源码资源等恢复依赖，归档后从回执复用。保留原始执行回执，不回收凭据、缓存或整个工作目录。源码审阅及研究计划确定后使用；不训练、不启动业务或评测。中断后重试核对当前摘要，不重复有效步骤。'],
    ['compute-variants/build-preview compute-variants/build', 'experiment_id entry_path expected_candidate_sha256 expected_preview_sha256', '先读取源码后构建；执行时服务器生成并校验真实构建预览。'],
    ['compute-variants/freeze-preview compute-variants/freeze', 'experiment_id case_ids evaluation_base_sha256 expected_preview_sha256', '使用 freeze-preview 返回的 freeze_input，核对真实差异与摘要；冻结遵循 DSH 原生权限；不得用 human_confirmed 代替人员复核。'],
    ['compute-variants/compare', 'experiment_id parent_run_ids variant_run_ids', '比较固定父版与变体的真实 Run；助手不能确认 end。'],
    ['tasks/capabilities', 'agent_id source server_id'],
    ['tasks/assembly-preview tasks/assembly-apply', 'target_source expected_candidate_sha256 files configuration_edits', 'files[{source,path,target_path?,expected_source_sha256,expected_target_sha256}]；configuration_edits[{path,content,expected_target_sha256}]，摘要取真实来源。'],
  ],
}

export function assistantActionContract(domain: AssistantDomain, action: string): { domain: AssistantDomain; action: string; input_schema: MapValue; instructions: string } {
  const hint = hints[domain].find(([names]) => names.split(' ').includes(action))
  if (!hint) throw new Error('未知的领域操作合同')
  const properties = Object.fromEntries(hint[1].split(' ').filter(Boolean).map(key => [key, fields[key] ?? (/^(?:.*_id|.*_sha256|.*_ref|agent_id|source|target_source|name|description|role|path|ref|content|title|scene|expected_behavior|mode|executor|review|model|compare_to|left|right|filename|status|outcome|operation|serverId|sourceId|componentId|compositionId|artifactId|toolName|specUrl|uri|version|revision|topic|variant_name|strategy|resource_metric|variant_model|variant_reasoning_effort|entry_path|check_id)$/.test(key) ? string : {})]))
  if (action === 'eval/preview' || action === 'eval/start') {
    properties.program_root = { ...string, description: '可选的已构建程序根绝对路径；省略时使用当前平台程序。评测保留原生模型策略和凭据注入。' }
    properties.concurrency = { type: 'integer', minimum: 1, maximum: 8, description: '独立 Case 并发上限，默认1；只并行 parallel_cases，其他用例独占执行。' }
    properties.parallel_cases = { ...strings, description: '已确认互不影响的所选 Case ID；同一业务资源的写操作不得并行。' }
    if (action === 'eval/start') properties.run_id = { ...string, pattern: '^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', description: '原样使用eval/preview返回的预留Run ID；无预留、已清理或过期时不得重发启动。' }
  }
  if (action === 'eval/batch-start') properties.requests = { type: 'array', minItems: 1, maxItems: 8, items: { ...assistantActionContract('agents', 'eval/start').input_schema, required: ['source', 'source_ref', 'run_id'] } }
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
  if (action === 'fusion/recover') properties.recovery = { type: 'string', enum: ['rollback', 'complete'] }
  if (action === 'fusion/resolve') properties.resolutions = { type: 'array', items: { type: 'object', required: ['path', 'decision', 'reason'], properties: {
    path: string, decision: { type: 'string', enum: ['source', 'target', 'delete', 'content', 'result'] }, reason: string, content: string, expected_result_sha256: string, mode: { type: 'integer', description: '普通文件 420（0644），可执行文件 493（0755）。' },
  } } }
  if (action === 'migrations/resolve') properties.resolutions = { type: 'array', items: { type: 'object', required: ['notes', 'case_ids'], properties: {
    mapping_index: { type: 'integer', description: 'status.unresolved_items返回的原mapping索引，与uncovered_index二选一。' }, uncovered_index: { type: 'integer', description: 'status.unresolved_items返回的原uncovered索引，与mapping_index二选一。' },
    disposition: { type: 'string', enum: ['converted', 'native', 'outside-scope'], description: '省略为converted；outside-scope只说明当前明确范围，不表示实现，不允许提供target，仍须保留真实Case依据。' }, target: string, notes: string, case_ids: strings,
  } } }
  return { domain, action, input_schema: { type: 'object', properties, ...(action === 'eval/start' ? { required: ['source', 'run_id'] } : ['eval/status', 'eval/cancel'].includes(action) ? { required: ['run_id'] } : {}), additionalProperties: true },
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
