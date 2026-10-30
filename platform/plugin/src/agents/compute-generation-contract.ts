/** 程序侧公开 SDK 与接口合同；研究策略和方法仍由数据工作区维护。 */
export function computeGenerationContract() {
  return {
    sources: {
      runtime: 'platform/plugin/src/workflows/runtime.ts',
      fixed_compositions: 'platform/plugin/src/workflows/fixed-composition.ts',
      plan: 'platform/plugin/src/agents/compute-variants.ts',
      build: 'platform/plugin/src/agents/compute-build.ts',
      freeze: 'platform/plugin/src/agents/compute-freeze.ts',
    },
    generation: {
      mode: 'langgraph-aot',
      default_entry_path: 'dsh/managed/compute-workflow/index.ts',
      fields: {
        entry_path: 'Candidate 内 dsh/managed/ 下的 .ts 文件；不能含空路径段、.、.. 或反斜线。',
        source_run_ids: '必填非空 Run ID 数组，引用所选固定父版的真实诊断轨迹；来源证据及摘要由 preview 核对。',
        fixture_sha256: '可选的 64 位小写十六进制固定外部输入摘要；必须与诊断 Run 一致。',
      },
    },
    variant_name: 'preview/create 独立传 variant_name：1–80 字符的单行名称，只保存在 change.yaml.variant_name，不从 strategy/research_question 截取；生成时保留已有名称。rename 仅改名，携带最近 context/detail 的 change_sha256 作为 expected_change_sha256。',
    execution_mode: 'code-only 要求 LangGraph 生成计划，业务主回合、工具背后和辅助处理均为零模型调用，不能声明模型变更。hybrid 使用本地原生回合派发和图内双模型角色，必须提供 generation 与 model_roles，不能同时使用单模型 model_change。缺省保持已有编排方式。',
    model_roles: {
      shape: '{language:{provider,model,reasoning_effort},decision:{provider,model,reasoning_effort,checkpoint_sha256,state_constructor_sha256,calibration_sha256}}',
      semantics: '两角色必须使用不同的实际 provider/model。三个决策产物摘要均为 64 位小写 SHA-256，运行前冻结；语言模型只负责解释及必要文本，决策模型只通过类型化原生工具产生决定。实际图请求逐项核对角色、路由和产物身份，失败与每次重试均计量。',
    },
    available_tools: ['skill', 'platform_agents'],
    sdk: {
      module: '@harness-platform/workflow-runtime',
      exports: ['defineWorkflow', 'runWorkflow', 'registerWorkflowTool', 'registerCodeOnlyWorkflowAgent', 'registerHybridWorkflowAgent', 'fixedCompositionToolName', 'Annotation', 'StateGraph', 'START', 'END', 'LlmError', 'attributionHeaders'],
      provider_adapter: '自定义模型适配器复用当前锁定 DSH 的 attributionHeaders()；已取得真实 HTTP status/requestId 的失败使用 LlmError(message,code,{status,requestId})，有效 usage 如实保留。没有响应的网络错误保持调用未知，不补造 Token、服务 ID 或模型版本。',
      types: ['WorkflowDefinition', 'WorkflowContext', 'WorkflowModelBinding', 'WorkflowModelRoles', 'FixedCompositionBinding'],
      plugin: '入口导出 name、inject、apply(ctx)，普通模式在 apply 内调用 registerWorkflowTool(ctx, workflow)；code-only/hybrid 模式只调用对应 register*WorkflowAgent，它会注册工作流工具，不能重复注册。普通模式 inject 包含 tools；使用 infer 时加 llm，使用固定组合时加 webServer、mcpSessionManager。',
      registerCodeOnlyWorkflowAgent: 'registerCodeOnlyWorkflowAgent(ctx,{presetId,workflow,renderResult?})：入口 inject 包含 tools、llm、sessionTitle，llm 仅注册原生本地适配器；本轮用户文本进入图 context.input.request，默认从真实结果读取非空 reply。所有输入均通过图处理；context.infer 在此模式拒绝。使用确定性标题，并在目标 Profile/Preset 禁用 session-title-llm、compaction-basic 和 command-compact。Candidate dsh/managed/role-tool-matrix.yaml 的 runtime_capabilities.local_tools 声明工作流及原工具，local_model_routes 声明 {provider: harness-code-only, model: workflow-v1}；原工具 Guard 须允许工作流及其真实子工具，禁止绕过。',
      registerHybridWorkflowAgent: 'registerHybridWorkflowAgent(ctx,{presetId,workflow,modelRoles,renderResult?})：modelRoles 使用计划 model_roles；inject 为 tools、llm、sessionTitle。原生外层路由固定 {provider:harness-workflow,model:hybrid-v1,reasoningEffort:off}，只派发一次真实图工具再读取本轮同 Session/call/turn 回执；恢复或取消不重放写操作。其余 Preset 不受影响。使用确定性标题，禁用 session-title-llm、compaction-basic、command-compact；角色工具矩阵声明本地派发路由、工作流与真实子工具。图的 execution_mode 为 hybrid，不能宣称 code-only。',
      defineWorkflow: 'defineWorkflow({id,toolName,description,inputSchema,run,fixedCompositions?})：前五项必填，run(context: WorkflowContext): Promise<any>；业务输入读 context.input，插件 name 不替代 id/toolName。',
      runWorkflow: 'runWorkflow(context, steps) 直接接收原 context。steps 为非空数组，每项 {id,run(values,context): Promise<any>}，id 不重复；values 初始为 {}，节点结果存 values[id]，返回完整结果映射。也可用公开 StateGraph 自行建图。',
      context: {
        fields: ['input', 'signal', 'executionId', 'trace'],
        callTool: 'await context.callTool(name,args) 返回原生工具 result.value；没有第三个 signal 参数，取消信号自动传递，工具错误抛出。经 ctx.tools.execute 派发，保留原生 Guard、调用身份、取消与实际回执，不能直接 HTTP 绕过。',
        infer: 'await context.infer(config,{system?,messages}) 返回 {content:string}；messages 必填。普通模式使用固定父版实际模型路由；hybrid 仅允许 modelRoles.language 的 provider/model/reasoningEffort，记录 model_role:language。运行库记录请求、失败和重试；其他异步操作使用 context.signal。',
        decide: '仅 hybrid：await context.decide(name,args) 返回 typed_decision 普通非空 JSON 对象，经原生工具执行器与 Guard 派发。决策服务及产物使用 modelRoles.decision；args 不能自带 model_execution。SDK 注入 model_execution={execution_id,role:target,session_id?,tool_call_id?,parent_run_id?,case_id?,decision_call_id}，工具原样回传。业务决定类型和值域由 Candidate 的原生工具适配器按实际服务协议校验。',
      },
      typed_decision_receipt: {
        tool_value: '{typed_decision:<非空JSON对象>,model_execution:<SDK原样身份>,model_requests:[{request_id,status,model_invocation?,provider,model,reasoning_effort,checkpoint_sha256,state_constructor_sha256,calibration_sha256,usage?}]}',
        requests: '每次真实模型 HTTP 请求（包括失败与重试）各一条；request_id 为实际请求的稳定唯一 ID；status 为 completed/failed/cancelled。model_invocation 为 true 表示已证实派发，false 表示已证实未派发；网络中断等无法确定时省略，保留 unknown。completed 必须 true。usage 使用实际 inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens，缺失保留未知，不填零。',
        accounting: '返回值和原生工具失败回执仍应携带 model_execution/model_requests。SDK核对路由与三个产物摘要，将请求按 execution_id/request_id 去重写入 graph_execution.model_attempts，标记 kind:typed_decision、model_role:decision。丢失、冲突或不匹配的回执导致节点失败并保留未知调用，不能报零模型请求。',
      },
      output: 'run 返回无损 JSON：普通对象、数组、字符串、有限数字、布尔或 null；无值字段省略或设 null，禁止 undefined、NaN、Infinity、类实例和循环引用。registerWorkflowTool 返回 {ok,result?,error?,graph_execution}，必须检查 ok 和图状态；模型退回原子工具后答对不能证明工作流成功。',
      fixed_compositions: {
        binding_fields: ['group_id', 'group_link_version', 'group_target_digest', 'tool_name', 'compositionId', 'versionId', 'expectedImplementationDigest', 'input_schema'],
        dispatch: '从 tasks/capabilities 读取真实目标原生分组、工具 schema 与固定版本。fixedCompositions 以原工具名为键传给 defineWorkflow；context.callTool 仍用原名，运行库注册固定别名。用 fixedCompositionToolName(name,binding) 计算别名，Preset/Guard 同时保留工作流、原工具与别名。版本元数据仅由受信 helper 注入，不放进业务参数；未知回执保持未知。',
      },
    },
    operations: {
      preview_create: 'compute-variants/preview/create 使用同一 parent_experiment_id、git:<40位提交>、variant_name、strategy、case_ids 和 generation；全链零调用传 execution_mode:code-only，双模型传 execution_mode:hybrid 和 model_roles。create 携带实际 preview_sha256 为 expected_preview_sha256，不能猜摘要。',
      edit: 'edit/read 后用 edit/preview、edit/apply 保存完整文件正文 edits[].content 及 expected_sha256；新文件须先取得 exists:false、sha256:null，保存传 expected_sha256:null。Preset 引用 Managed 源码对应的 /opt/dsh-managed/compute-workflow/*.mjs。',
      build: '保存后读取当前 candidate_sha256，以 expected_candidate_sha256 调 build-preview；build 保留该摘要和实际预览的 expected_preview_sha256。只做类型检查和固定 ESM 编译，不执行 Candidate，不证明装载。源码、runner、依赖或 ESM 变化后旧构建失效。',
      freeze: 'freeze-preview 返回 Candidate、研究计划、本版本 evaluation 研究资料和选定 Case 的真实差异与 freeze_input={experiment_id,case_ids,evaluation_base_sha256,expected_preview_sha256}；freeze 完整传回 freeze_input。训练监督数据与评估报告保存在本版本 evaluation，不能放入 Runtime 挂载的 Candidate。仅本地冻结约定文件，不推送；两侧 Run 的提交须含同一计划。',
      evidence: '分别核对 context.workflow_status 的 generated/built/frozen/loaded/compared。新 Session 的真实图回执须与当前源码、build_digest、esm_sha256 及固定组合身份一致，且 complete=true、status=completed；构建通过或原子回退不等于装载成功。',
      delivery: '通过 compute-variants/compare 核对实际构建、冻结、装载与所选两侧 Run。human_confirmed 只能由用户在变体页面复核，不能由助手提交或改结论字段。',
    },
  }
}
