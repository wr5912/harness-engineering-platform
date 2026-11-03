# 算力变体代码归拢与技能整改核验

对象为 `VAR-security-operations-expert-003-r6fcbc8e8f093`，关联 `PA-03/04/06/10/12`。目录整改修正新增算力实现的归属、平台文件移动合同及管理助手技能，保留继承的通用插件布局。后续共享用例口径修订单独记录于[共用业务用例核验](../evaluation-neutrality-20261103/README.md)。

## 根因与整改

原算力技能规定了入口、构建和冻结，但没有要求先明确新增实现的归属目录，也没有在交付前检查最终目录；生成合同允许跨目录引用，构建成功只能证明类型与依赖可解析。插件开发技能未被明确串入算力生成步骤，平台编辑动作也缺少真正移动文件的能力。此前开发复核漏查目录结构，是本次交付遗漏，不能仅归因于助手模型。

现在由 `compute-variant-research` 维护目录归属、继承边界、引用更新和回读检查，`dsh-business-plugin-development` 引用该要求，生成合同提供同一入口。编辑动作增加可选 `edits[].move_to`：同一 Candidate 内移动，固定源摘要、拒绝目标覆盖及批内路径冲突，保留文件权限，后续写入失败时恢复本次移动。

## 实际结果

通过平台 `agents/edit/read → preview → apply` 移动 13 个文件，同批更新主入口与 Preset。新增实现集中于 `candidate/dsh/managed/compute-workflow/`，入口 `index.ts` 和生成的 `index.mjs` 保持稳定；`routing/` 保存路由与状态投影，`models/` 保存模型适配，`business/` 保存业务续办及独立巡检入口，`training/` 保存已有训练源码快照。清单与核心实现放在入口目录。继承的通用插件原位保留，模型权重、训练数据、日志和研究报告未移入 Runtime 代码。

- [迁移回执](migration.json)：13 个原路径均不存在，15 项写入逐项回读一致。
- [受控构建](builds.json)：独立巡检与主入口均通过类型检查和 ESM 构建；主入口产物 SHA-256 为 `d77c3252aebd2a5e75c4f2a6e5f0cab7bee3ed383bcd57c00e4c588e84c8bc6b`，独立巡检产物为 `16903babe7cdca98af98fee96a0d9a1fa1af149ff9faf5c9a749a271e7b7cae8`。
- [源码目录回读](context.json)：14 项可预览代码及配置均在新目录、没有缺失；资产树同时显示训练源码快照。
- [实际浏览器](browser.json)及[资产树截图](assets-1440.png)：从算力页“查看生成代码”定位真实资产，1440/768/390px 无横向溢出、无脚本错误。仅保存桌面截图，不以源码测试替代页面核对。
- `agents.test.mjs` 和 `assistant.test.mjs` 共 149 项通过，涵盖移动及同批引用、只读预览、旧摘要、目标占用、批内冲突、越界、非法 ESM 与后续写入失败回滚；`pnpm run build` 类型检查和构建通过。测试为当前受影响路径，非全平台完整验收。
- 平台插件经原生更新生效，主进程 PID 保持；仅定向重启专用变体实例，保留 HOME、端口及标准 Runtime 镜像。更新该实例私有绑定和训练快照路径的直接消费者后，容器内 KEV、Qwen 普通请求及 SSE 三项服务实测通过。私有绑定不入本证据。

## 未完成与限制

冻结预览最初因共享 `evaluation.md` 的两个规则 Case 被并行修改而拒绝；随后用户要求修订共用业务预期，更多所选 Case 与旧计划摘要不同。保留并行修改、原计划及历史冻结，重新确认口径后才能通过原生工具冻结与启动新比较；不通过任意 Git 操作替代冻结。当前 `built=true`、`frozen=false`、`loaded=false`、`compared=false` 以回执为准。

`model_policy_unavailable` 的根因为外部模型目录没有合并 Candidate 声明的本地工作流路线；已复用现有能力矩阵解析修复，13 项模型投影测试通过。真实平台对 `harness-workflow/hybrid-v1` 的 [dry-run 预检](model-preview.json)已通过来源、用例和模型策略核对，没有缺少的环境变量。容器内模型 HTTP/SSE 与 dry-run 均不证明 DSH 插件已正确完成一次新业务 Session，两侧完整业务比较仍未通过；不提升业务等效、Research Release 或整体项目验收状态。训练快照字节未改、原训练身份与原始回执路径保持，迁移后的快照不作为新的训练入口。
