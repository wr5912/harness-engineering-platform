# 原生会话检查移除与长任务耗时整改核验

2026-11-06 UTC，范围为 PA-01、PA-03、PA-08、PA-10、PA-12 的相关分项。当前合同见根级 AGENTS.md、设计 02/04 及数据工作区的管理技能；本记录保存本次诊断与验证，不替代长期规则。

## 两次耗时的实际组成

复用原生 Session v4 事件，只读分析用户反馈会话的第 12、14 轮。用户消息事件分别为 856、1076；原始压缩轨迹留在数据根 `.local/platform-home/sessions/`，没有复制 HOME、正文或凭据到仓库。新增统计通过既有 `kev_trace.py audit` 输出 timing.json；本次历史重算仅使用 timing_summary，不代表完整训练数据抽取审查通过。

| 原生轮次 | 用户消息至 turn/end | 模型步骤区间并集 | 工具区间并集 | 压缩区间并集 | 重试等待 |
|---|---:|---:|---:|---:|---:|
| 排序，第 12 轮 | 2827.872 秒 | 2817.403 秒 | 4.620 秒 | 0 | 0.771 秒 |
| “继续”，第 14 轮 | 2055.146 秒 | 1946.923 秒 | 5.969 秒 | 93.488 秒 | 0.534 秒 |

界面从稍早的 turn/start 计时，显示约 47 分 8 秒、34 分 16 秒；表中从实际用户消息起算，因此略短。各类区间可能重叠，不能相加推算墙钟总时长。模型步骤含供应商等待、生成和流式输出，不能全部解释为模型思考；当前事件不足以进一步精确分离供应商内部耗时。可复核的结构化结果见 [timing.json](timing.json)。

排序轮的两次整份正文预览和一次整份应用分别约 484.595、487.773、881.723 秒，合计约占总耗时 66%；一次提交还遇到其他会话的摘要并发冲突。“继续”轮再次生成全文的预览、应用分别约 660.175、441.143 秒，合计约占 54%，并发生 93.488 秒压缩；该轮还修正了误改的 U-SCHED-002 正文。工具本身均不足 6 秒。证据支持优先减少重复全文生成、保留局部变更及真实回执续办，尚不证明整改后每轮模型耗时达到目标。

## 原生父子关系与平台拦截的根因

原生新子会话的 header.parentSession 已正确指向父会话，origin=subagent、depth=1、isSeeded=false。平台过去额外要求本地 assistant 投影存在且 active，并把 Agent 显示 ID 当成 Session ID；新子会话不具有平台激活记录，因此在工具入口被拒绝为“当前 Session 不是平台管理会话”。原生父子关系本身没有丢失。

历史上 22ceb7b1 的平台激活概念和 51339f3c 的工具资格检查形成这项假设；062b7187 的上一轮原生复用整改移除了部分包装，仍留下这条入口。本次直接删除平台资格检查及提示词装配 Hook，不再补建一套原生关系识别或父子关系校验。

## 实现范围

- 删除管理会话激活资格、父子关系复核、可选管理资产预检、专用任务动作白名单、describe 解锁、动态工具 Schema 和 AGENTS.md/Skill 全文系统提示注入。Skill 和工作区规则由 DSH 原生加载，任务上下文作为提交任务的普通用户内容提供。
- 平台工具以真实原生 session.header.id 记录回执，原生子会话和未激活会话均可按 DSH 原生权限调用。describe 仅查询合同；显式目标保留，任务上下文只补省略参数。真实业务来源、参数、摘要、并发写入、权限及未知回执恢复仍然生效。
- 新增 cases/reorder-preview、cases/reorder，共用现有 canonical evaluation 解析与摘要写入服务。请求仅含 Experiment、scene、完整 Case ID 排列及当前摘要；移动原用例块，保留其他内容及分隔换行，返回顺序和摘要。完整性、跨场景、重复/遗漏、语义变化、取消和并发冲突均拒绝；顺序已满足不写入。
- 强制绑定数据根、撤销其他工作区登记及“思考中”状态文字继续保留。没有修改 DSH 源码、原生重试、执行循环、权限或消息展示，没有新增部署依赖。
- 两仓 AGENTS.md、研发和管理技能、平台设计同步。排序流程及“继续”从首个未完成步骤办理的规则由数据技能维护。既有轨迹审查增加按原生轮次统计的 timing.json；缺失时间、未结束及不完整区间保持未知，父子会话分开报告，复制工具结果不重复配对。

## 验证与限制

程序基于主线 062b71874873a50785c74fc7cc7e63c74c94d19f，数据基于 66caaa8c4e56648d4082eb409b8cb481a9427540；分别只应用本次差异到独立工作树，排除了共享工作区中并行的 MCP、编号和业务 Candidate 修改。

| 检查 | 结果 |
|---|---|
| 程序隔离类型检查与构建 | 通过，见 [build.log](build.log)。复用现有依赖，不增加包。 |
| 管理对话、排序与工作区回归 | 128/128 通过，见 [tests.log](tests.log)。包含真实 HTTP、SDK ToolRuntime、SessionStore、原生 deny/ask/allow、未激活会话及新建原生子会话；覆盖正文与 fast/注释保留、LF/CRLF、末尾无换行、多同名场景段、普通四级标题、空操作、冲突及取消。模型调度使用夹具，不代表真实 LLM 业务效果。 |
| 数据轨迹工具隔离回归 | 共 144 项，142 通过、2 跳过，见 [timing-tests.log](timing-tests.log)。包含区间并集、重试、复制结果、缺失时间、未完成及父子关系。首次独立调用遗漏 PYTHONPATH 导致导入失败，补齐既有脚本路径后完整复验。 |
| 状态文字适配 | 10/10 通过，见 [wording-tests.log](wording-tests.log)。保留原生计时占位和无障碍行为。 |
| 当前实际浏览器 | 桌面 1440×1000、手机 390×844 的空闲会话页可见原生工作区、侧栏、附件和发送控件，无脚本异常或横向溢出；没有发送消息或核验进行中流。不能据此声称新后端已经装载。 |
| 本地装载 | 维护工具 update --dry-run 返回 busy、activation:none，见 [回执](update-pending.json)。仍有管理会话和评测在途，未中断或重启它们。 |

执行命令：

```sh
# 程序隔离工作树 platform/plugin 下
pnpm run build
HARNESS_DSH_ENTRY="$(readlink -f "$(command -v dsh)")" node --test test/assistant.test.mjs test/assistant-client.test.mjs test/assistant-scope-switch.test.mjs test/assistant-projection-cache.test.mjs test/independent-workspace.test.mjs test/evaluation-cases.test.mjs test/extraction-scope.test.mjs
# 数据隔离工作树根目录下
PYTHONPATH=.agents/skills/kev-trace-pipeline/scripts python3 -m unittest discover -s .agents/skills/kev-trace-pipeline/scripts/tests
```

当前实际服务端尚未装载本次整改。待在途工作结束，通过维护工具 `platform/dsh-deploy update` 更新，保留 HOME、会话、端口及业务实例；再由管理助手完成排序、继续、原生子会话和思考/工具流复验。三轮同类真实模型任务的中位数不超过 5 分钟仍是待验证目标，不能由脚本耗时或静态回归推定。未修改或重跑业务评测、Research Release、外部服务或远端部署，不提升相关路径的整体完成状态。

## 本机装载补验（2026-11-06 UTC）

用户明确要求重启后，通过 `platform/dsh-deploy update --interrupt-sessions --json` 更新本机 `18120`，回执为 `applied`、`managed-restart`，PID 从 `4130730` 变为 `204164`。应用前只有管理会话在途，本次允许中断其执行并保留记录；没有独立评测或业务操作阻塞。装载范围包括当前工作树中的并行修改，不仅是上文两个任务提交。维护工具核对并保留监听地址、工作区与 HOME；后台制品摘要与本次暂存构建一致。

实际浏览器完成登录及桌面、窄屏原生会话页核对，无脚本异常或横向溢出；在线 inventory 的数据根及工作区身份正确，新增排序预览入口对缺失参数返回 `invalid_request`，证明当前请求已到达新处理器。515 份原生会话轨迹均保留，11 个既有容器的启动时间和重启次数未变化。未发送新的模型任务或执行业务写入，真实模型提速、排序和续办效果仍待复验。

本机维护回执位于 `.local/platform-updates/3dc663ed-6118-4670-a2f7-f44f68ba445f/receipt.json`；浏览器和会话、容器保留核对位于 `/tmp/hep-platform-restart-20261106/`。临时浏览器脚本首次使用了非安全 HTTP 上不可用的 `crypto.randomUUID()`，改用本地时间生成核验请求 ID 后通过；未修改平台代码。
