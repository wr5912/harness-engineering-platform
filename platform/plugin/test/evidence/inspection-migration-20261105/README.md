# 原生组合编排与管理助手开发能力核验

本记录对应 `PA-12`，时间为本地 2026-11-05（UTC 2026-11-06）。对象为当前开发平台、MCP 数据资产及指定 `027` 版本；未更新远端或修改外部服务源码。

## 能力与方法

六项巡检组合采用官方 Langflow/LFX 原生流程，画布与执行读取同一份定义；发布冻结流程、组件模块和固定子组合。共用开发方法在数据仓库 [composition-development.md](https://github.com/wr5912/harness-engineering-platform-data/blob/main/mcp/docs/composition-development.md) 维护，管理助手的 [mcp-composition 技能](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/mcp-composition/SKILL.md) 按需引用，研发技能沿同一入口查找，不复制实现字段或运行日志。

方法覆盖需求与副作用、复用边界、原生控制流程、草稿与发布、分层验证、原 Run 恢复和性能比较。LFX 保留字段、代理影响本地流式回调、错误或缺失结果、版本参数及装载身份等经验链接到实现或回归。管理助手可以维护授权的数据流程资产并使用平台工具验证；新工作流登记、平台源码、构建和装载仍由研发处理，未证明可以独立完成任意新编排。

## 真实使用与根因修复

管理助手会话 `session-6ea22501-7c81-4b5c-b024-07939e827c55` 实际读取当前技能和方法，完成常规巡检 dry、真实调用、图查询及报告回读，并将分页核对和计量边界补入共用方法。真实 Run 为 `run-fcaa78bb-c227-4bf2-aad3-7997327b6443`。

助手发现报告有 8 项事实而节点明细为空。根因是原生执行保存了树状业务结果，节点进度记录没有重复保存结果，查询只读取节点自身。共享查询层现从已保存结果解析对应父子明细，保留原分页合同，不重跑、改写历史记录或向各节点复制全量数据。

助手随后仅回读同一 Run，每页 2 条，读完 `root` 8 项、`root/status` 1 项、`root/baseline` 1 项及 `root/reachability` 6 项，按对象和结论与原 JSON 报告核对一致。根节点为 1 项正常、7 项未知；执行 `completed`，业务 `incomplete`。原文及核对数据见 [assistant-readback.md](assistant-readback.md) 和 [verification.json](verification.json)。这是一次实际使用验证，不是触发率或成功率对照实验。

图查询合同补齐当前选择 `version` 与固定身份 `versionId` 的区别。源码查询可用 `selection={id,version:published,versionId:实际ID}` 读取固定发布包；真实查询已确认 `server.py` 与构建摘要一致。源码查询说明曾错误列出 `version:version`，说明与 Schema 已修正并通过回归；更新工具首次因其他在途会话暂缓，待会话空闲后重试已完成本地装载。

## 检查与画布

- 官方运行时执行六项实际流程通过：[日志](official-flow-tests.log)。共享明细及历史记录不改写回归 3/3：[日志](details-tests.log)。管理助手逐动作合同回归 1/1：[日志](assistant-contract-test.log)；类型检查通过。
- 实际平台画布核对可达性四路条件、批量内部路径与 ACL 分支、汇合，以及父流程进入固定子版本；桌面和 390px 页面未见横向溢出。见 [browser-checks.json](browser-checks.json)、[主流程](reachability-flow-current-desktop.png)、[批量内部流程](reachability-batch-current-desktop.png)、[手机](reachability-batch-mobile.png)和[固定子版本](fixed-child-desktop.png)。没有客户端响应夹具；手机未逐节点验收文字可读性。
- 平台共享明细及源码查询合同修复均由 `platform/dsh-deploy update` 装载；空闲检查通过后执行管理重启，未取消其他任务。共享明细及源码查询合同均已由助手只读回读验证，未重复执行巡检；源码复验原文见 [assistant-source-readback.md](assistant-source-readback.md)。独立 LFX 进程加载的文件字节及业务扩展运行摘要未进一步核对。

## 业务验收边界

指定 `EXP-security-operations-expert-027-f-r3ba4799b0cb7` 的完整 Run `run-32d64186-73e1-4686-b6a5-4a055faea53f` 共 14 项：11 项通过、3 项结论不足。具体结果和周期实例装载缺口只在该版本的 [Decision](https://github.com/wr5912/harness-engineering-platform-data/blob/main/evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/decision.md) 及其 Run 维护；当前仍为 `continue`。旧 inspection 连接和专用分组未清理，等待使用方完整验收。

没有建立端到端性能对照，不声称执行效果或耗时已经最优；本记录不提升 `PA-12` 整体、Research Release 或生产部署结论。
