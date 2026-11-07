# 策略与应急迁移：接口接入与固定流程分工核验

对应 `PA-08/12`。本记录取代[旧八包方案](../policy-response-migration-20261106/README.md)的当前状态说明，历史失败保留。业务来源、范围及设计分别见数据工作区的[迁移说明](/home/cmp/harness-engineering-platform-data/mcp/docs/policy-response-migration.md)和[交互设计](/home/cmp/harness-engineering-platform-data/mcp/docs/policy-response-interaction-design.md)。

## 当前范围与结果

管理助手已撤除八个未发布旧编排，接入 `policy-response` 原始工具分组；现有六项巡检组合保留。当前策略、应急可用路径仍由 Skill 调用原接口，固定调用链的替代组合尚未实现或发布，不能据此认定迁移全部完成。未修改外部 AISOC 仓库，未执行策略提交、审批或真实应急动作。

本地定向回归：助手与 MCP 分组 106/106，工作流及 LFX 12/12，数据侧巡检 14/14；官方 LFX 的六种巡检流程验证通过。指定 Candidate 的 Guard 延迟服务注册回归 8/8 通过。程序构建通过，但本任务平台更新被其他在途管理会话暂缓，未强制中断；构建不等于 18120 已装载全部程序修改。

业务 Harness 的来源、真实 Run、机器判定及未完成项仅在目标 Experiment 的[观察记录](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/evaluation/observations.md)维护，不将工具可见或只读通过外推为草稿创建、下发或设备效果通过。

## 管理助手实际分工核验

2026-11-06 UTC，在当前 `18120` 上新建管理会话 `session-a1e87a66-861d-4723-a0fe-7cde6d42f6c9`，提交 `3457db20-a7f9-4c97-851d-815f8cf2b75b`。任务只要求读取当前方法并判断两个场景，不在提示中指定分工答案，也不调用 SOC、修改文件或创建发布组合。

原生轨迹实际调用 `skill(mcp-composition)`，随后 `read` 当前技能及 `mcp/docs/composition-development.md`；工具回执包含“固定的多个接口连续调用、返回数据加工、后续调用及异常恢复，尽可能使用工具组合编排”。会话最终 `running=false`，事件序列至 86。

| 场景 | 实际回答 | 判定 |
| --- | --- | --- |
| 设备和参数已明确，仅保存草稿；预览、创建、原号回读及异常处理均固定 | 固定链交组合执行，Skill 负责意图、选择与解释；三次调用不是排除组合的理由，写入未知先查询、不盲目重建 | 符合当前分工原则 |
| 不知道哪些设备有问题，先咨询并选择目标 | Skill 与原始查询工具承接探索；确定性的只读分页、关联和汇总片段仍可组合，不提前进入变更 | 符合当前分工原则 |

这证明本次真实管理会话已经读取并运用当前规则，未验证所有入口或历史会话自动更新。旧迁移会话曾向子任务传递“≤3 次默认 Skill”的过时门槛，已发出重新读取与同步纠正的指令；不能把发送指令视为旧会话已经完成重载。规则唯一维护于[组合开发方法](/home/cmp/harness-engineering-platform-data/mcp/docs/composition-development.md#先判断是否需要组合)，根级原则、实施技能和审查技能引用它。

未验证真实组合执行与性能收益；本次分工核验不等于业务 Evaluation 或 Research Release 通过。
