# 零模型代码变体的平台与实际装载验证

2026-10-26 执行，2026-10-27 整理证据。程序以远端 `2fb0b0e` 为基线，在 `feat/PLATFORM-code-only-variants` 开发；最终四个比较 Run 均记录程序 `4f86644dd7a980ca12529dc613ba56eebcafaa44`、工作树 clean。数据使用独立工作区，保留任务前已有配置与无关资料，未推送任一仓库。

## 平台合同

低算力方案支持 `execution_mode: code-only`，要求业务会话全链零模型请求。生成合同使用公开 SDK `registerCodeOnlyWorkflowAgent`，由本地 DSH adapter 调度工作流并返回结果；标题同样由代码生成。图内 `infer` 被拒绝，固定本地路由不计为远程请求；其他未知路由和不完整采集不能证明零请求。旧方案保留原有合同，历史 `model_calls` 明确显示为“会话回复次数（历史口径）”。

界面实际完成方案读取、源码展示、构建、冻结、分别发起两侧评测、选择最终四个 Run 和比较。1440px 与 390px 的方案页均显示零模型选项，无横向溢出及页面脚本错误，见 [视口记录](platform-ui-viewports.json)、[桌面](platform-plan-1440.png)和[手机](platform-plan-390.png)。[源码页](conditional-source-ui.png)展示真实的 `addConditionalEdges`、`if/else` 和五条分支。

最终比较没有将父版未知结果改判为通过；[界面结果快照](final-comparison-ui.json)与[比较页](final-comparison.png)显示资源证据通过、质量及可比性未通过、`eligible_for_end=false`，未提交人工确认。详细研究结果以数据侧不可变比较回执为准。

## 项目与工具链验证

| 受影响路径 | 现有回归结果 |
|---|---:|
| 零模型 SDK、Session 匹配、取消、标题 | 13/13 |
| 变体比较与旧方案兼容 | 40/40 |
| 真实请求与 Token 计量 | 22/22 |
| 界面方案、资源显示与历史口径 | 27/27 |
| 评审原文引用、工具结果、中文引号内完整要求 | 42/42 |
| 评测轨迹 | 12/12 |
| 容器宿主别名 Compose | 10/10 |
| 业务 Profile 与原生公开地址 | 13/13 |
| 数据侧业务扩展 | 17/17 |
| Candidate 规则与显式图 | 8/8 |

TypeScript 检查与平台 prepare 构建通过。评审只允许按有效证据索引补全缺失原文引用；已有错误引用、空值、无效索引或空工具结果仍失败，不作模糊匹配。原始评审历史保留。完整要求切分保留成对中文引号内的标点，最终两侧使用修正后相同执行器重新评测。

平台实际装载于 `10.0.160.32:18120/hep/`，数据根为 `/home/admin/harness-engineering-platform-data`，使用 `platform/dsh-platform` 统一生命周期。业务实例使用已有标准 AMD64 镜像，通过统一网关访问，未构建 Agent 派生镜像。

## 业务证据入口与边界

业务 Agent 为 `inspection-delivery-demo`，父版 `EXP-inspection-delivery-demo-002-r7430faf014e7`，变体 `EXP-inspection-delivery-demo-003-r1c42f11c4f9a`。变体 Candidate 冻结于数据提交 `25d98d97c9f48377f1c85b98a56c8e098e282d59`，构建摘要为 `f51cc11a7d9a5be8f1b08b24264ac21e10be3d6048eb9cb58a7bcf804e1db790`。

研究观察、四个最终 Run、机器比较结果和实际业务浏览器证据的唯一入口位于数据根：

```
evolution/experiments/EXP-inspection-delivery-demo-003-r1c42f11c4f9a/evaluation/observations.md
```

数据侧 `evaluation/evidence/ui-20261026/` 保存八轮真实 Session 的五分支摘要、准确构建来源、页面截图、Markdown/CSV 实际下载及回执。业务请求、辅助请求和 Token 均为零；独立评审使用模型并单列，代码生成不属于业务运行成本。

平台能力与工具链验证不代表等效假设成立。当前父版有五项评审无法判定，变体保持 `exploratory`、Decision 为 `inconclusive`，原活动版本未切换。仅覆盖固定 Mock 台账与现有四个 Case；未验证真实设备、开放领域语言等效、硬件算力收益、Research Release 或生产部署。
