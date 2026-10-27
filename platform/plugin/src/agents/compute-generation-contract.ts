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
    execution_mode: '低算力纯代码计划使用 execution_mode: code-only，要求 LangGraph 生成计划，业务主回合、工具背后和辅助处理均为零模型调用；不能同时声明模型变更。缺省保持已有编排方式。',
    available_tools: ['skill', 'platform_agents', 'platform_task'],
    sdk: {
      module: '@harness-platform/workflow-runtime',
      exports: ['defineWorkflow', 'runWorkflow', 'registerWorkflowTool', 'registerCodeOnlyWorkflowAgent', 'fixedCompositionToolName', 'Annotation', 'StateGraph', 'START', 'END'],
      types: ['WorkflowDefinition', 'WorkflowContext', 'FixedCompositionBinding'],
      plugin: '入口导出 name、inject、apply(ctx)，普通模式在 apply 内调用 registerWorkflowTool(ctx, workflow)；code-only 模式只调用 registerCodeOnlyWorkflowAgent，它会注册工作流工具，不能重复注册。普通模式 inject 包含 tools；使用 infer 时加 llm，使用固定组合时加 webServer、mcpSessionManager。',
      registerCodeOnlyWorkflowAgent: 'registerCodeOnlyWorkflowAgent(ctx,{presetId,workflow,renderResult?})：入口 inject 包含 tools、llm、sessionTitle，llm 仅注册原生本地适配器；本轮用户文本进入图 context.input.request，默认从真实结果读取非空 reply。所有输入均通过图处理；context.infer 在此模式拒绝。使用确定性标题，并在目标 Profile/Preset 禁用 session-title-llm、compaction-basic 和 command-compact。Candidate dsh/managed/role-tool-matrix.yaml 的 runtime_capabilities.local_tools 声明工作流及原工具，local_model_routes 声明 {provider: harness-code-only, model: workflow-v1}；原工具 Guard 须允许工作流及其真实子工具，禁止绕过。',
      defineWorkflow: 'defineWorkflow({id,toolName,description,inputSchema,run,fixedCompositions?})：前五项必填，run(context: WorkflowContext): Promise<any>；业务输入读 context.input，插件 name 不替代 id/toolName。',
      runWorkflow: 'runWorkflow(context, steps) 直接接收原 context。steps 为非空数组，每项 {id,run(values,context): Promise<any>}，id 不重复；values 初始为 {}，节点结果存 values[id]，返回完整结果映射。也可用公开 StateGraph 自行建图。',
      context: {
        fields: ['input', 'signal', 'executionId', 'trace'],
        callTool: 'await context.callTool(name,args) 返回原生工具 result.value；没有第三个 signal 参数，取消信号自动传递，工具错误抛出。经 ctx.tools.execute 派发，保留原生 Guard、调用身份、取消与实际回执，不能直接 HTTP 绕过。',
        infer: 'await context.infer(config,{system?,messages}) 返回 {content:string}；messages 必填，config 使用固定父版实际模型路由。运行库记录请求、失败和重试；其他异步操作使用 context.signal。',
      },
      output: 'run 返回无损 JSON：普通对象、数组、字符串、有限数字、布尔或 null；无值字段省略或设 null，禁止 undefined、NaN、Infinity、类实例和循环引用。registerWorkflowTool 返回 {ok,result?,error?,graph_execution}，必须检查 ok 和图状态；模型退回原子工具后答对不能证明工作流成功。',
      fixed_compositions: {
        binding_fields: ['group_id', 'group_link_version', 'group_target_digest', 'tool_name', 'compositionId', 'versionId', 'expectedImplementationDigest', 'input_schema'],
        dispatch: '从 tasks/capabilities 读取真实目标原生分组、工具 schema 与固定版本。fixedCompositions 以原工具名为键传给 defineWorkflow；context.callTool 仍用原名，运行库注册固定别名。用 fixedCompositionToolName(name,binding) 计算别名，Preset/Guard 同时保留工作流、原工具与别名。版本元数据仅由受信 helper 注入，不放进业务参数；未知回执保持未知。',
      },
    },
    operations: {
      preview_create: 'compute-variants/preview/create 使用同一 parent_experiment_id、git:<40位提交>、variant_name、strategy、case_ids 和 generation，低算力全链零调用另传 execution_mode: code-only；create 携带实际 preview_sha256 为 expected_preview_sha256，不能猜摘要。',
      edit: 'edit/read 后用 edit/preview、edit/apply 保存完整文件正文 edits[].content 及 expected_sha256；新文件须先取得 exists:false、sha256:null，保存传 expected_sha256:null。Preset 引用 Managed 源码对应的 /opt/dsh-managed/compute-workflow/*.mjs。',
      task: '当前程序的算力变体专用作用域实际提供 skill、platform_agents、platform_task，支持通过 platform_task 管理生成任务。连续任务用 preview/start，kind=compute-variant、source=experiment:<已派生目标>、compute_variant={parent_experiment_id,parent_ref}，evaluation_case_ids 与冻结计划一致。读取 compute-variant-research；任务授权不代替本地冻结确认。',
      build: '保存后读取当前 candidate_sha256，以 expected_candidate_sha256 调 build-preview；build 保留该摘要和实际预览的 expected_preview_sha256。只做类型检查和固定 ESM 编译，不执行 Candidate，不证明装载。源码、runner、依赖或 ESM 变化后旧构建失效。',
      freeze: 'freeze-preview 返回真实差异与 freeze_input={experiment_id,case_ids,evaluation_base_sha256,expected_preview_sha256}；freeze 完整传回 freeze_input 并单独确认。仅本地冻结约定文件，不推送；两侧 Run 的提交须含同一计划。',
      evidence: '分别核对 context.workflow_status 的 generated/built/frozen/loaded/compared。新 Session 的真实图回执须与当前源码、build_digest、esm_sha256 及固定组合身份一致，且 complete=true、status=completed；构建通过或原子回退不等于装载成功。',
      delivery: 'platform_task deliver 使用本任务实际启动的 parent_run_ids/variant_run_ids，服务端核对构建、冻结、装载与比较。完成不自动确认 end；human_confirmed 只能由用户在变体页面复核，不能由助手提交或改结论字段。',
    },
  }
}
