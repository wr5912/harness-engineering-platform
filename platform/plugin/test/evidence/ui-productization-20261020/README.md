# UI 产品化逐页验收（2026-10-20）

## 来源与运行范围

指定参考为 `Harness_UI_Product_Review_V1.0/Harness_UI验收参考原型.html`（SHA-256 `fe77f4b472ee5d0278956fa8a10532e15d4cb8fa242fc764a5378cde659a9923`）；输入 ZIP 的 SHA-256 为 `d4c4711975e849044f4d94aebfc54549e678c690715a7e0e6fd7874d84a9141c`。原型使用示例数据，页面实现读取当前工作区的实际对象与状态。

本轮验收使用 `feat/PLATFORM-ui-productization` 工作树。浏览器打开 `http://10.0.160.32:3091/hep/`，服务从本分支构建，使用独立数据根 `/tmp/hep-ui-acceptance-20261020-YzAfQF/data`。3090 未由本任务重载或操作；10 月 21 日 12:03 检查时该端口无监听、入口返回 502，停止原因未确认。“管理对话”保留 DSH 原生界面；本轮只通过它执行已有的一次确认流程。

## 逐页核对

| 页面 | 实际加载的页面 | 操作与状态核对 | 当前证据边界 |
|---|---|---|---|
| 首页 | [桌面](final/final-page-home-1440.png) · [手机](final/final-page-home-390.png) · [手机长图](final/home-mobile-full.png) | 按原型排列 Hero、任务输入、四个快捷入口、继续处理、最近工作、概况和引导；手机按原型收起右侧概况与引导。实际 3 条需处理 Run 和 2 条最近 Run 可精确进入原记录；四个入口的模式、输入焦点与草稿刷新恢复经[浏览器核对](final/home-shortcuts.json)，构建模式还核对了离开返回后的草稿恢复，[回执](final/home-draft.json)。 | 当前隔离数据没有运行中 Job 或待确认 Session；相关状态以合同测试覆盖。 |
| 智能体管理 | [桌面](final/final-page-agents-1440.png) · [手机](final/final-page-agents-390.png) · [最新版本导航](final/agents-version-nav-1440.png) | 6 个智能体的列表和详情、版本身份、最近评测、手机详情返回、改名草稿和迟到响应的对象保护。[版本导航复验](final/agents-version-browser-report.json)在 1440/390px 切换 `test01` 的两个真实版本，选中状态与页面地址一致，无页面错误或 5xx。 | 此页面未执行真实改名写入或版本登记；实例装载见实例管理验收。 |
| 评测中心 | [桌面](final/final-page-evaluation-1440.png) · [手机](final/final-page-evaluation-390.png) · [新 Run 详情桌面](final/mimo-eval-gui-detail-1440.png) · [新 Run 详情手机](final/mimo-eval-gui-detail-390.png) | 已保存 Run 的列表、执行状态与业务结论分列、五个结果页签、Case 定位、刷新及前进后退保持对象；未知 Job 链接显示可恢复错误。[路由回执](final/evaluation-routes.json)；[真实 Run 页面回读](final/mimo-eval-gui-readback.json)11/11 项通过，在桌面和 390px 列表、详情及逐例结果中核对 `023` 来源、`U-INS-003`、执行“已结束”与业务“通过”。 | 隔离 `023` 来源已完成一个单 Case Run；当前无正在运行的 Job，更多 Case 与完整 AI review 尚未执行。 |
| 实例管理 | [桌面](final/final-page-instances-1440.png) · [手机](final/final-page-instances-390.png) · [创建预览](final/final-instance-preview-1440-20261021.png) · [手机停止确认](final/final-instance-stop-390-20261021.png) | 来源搜索与选择、创建表单与预览、停止确认、无效深链及实例操作回执合同。[预览复验](final/final-instance-only-accept.json)16/16 项通过：真实 Run 标题、执行状态、业务结论、验证范围与核对时间分别呈现，创建预览可返回修改，停止预览读取现场状态和时间。[GUI 创建](final/mimo-gui-create-e2e.json)7/7 项通过，[创建画面](final/mimo-gui-create-e2e.png)确认 `023` 来源的 MiMo-V2.6-Flash/off 实例；[原生业务 Session](final/mimo-business-native-session-final.json)9/9 项通过，[原生页面回看](final/mimo-business-gui-view.json)3/3 项通过，均指向同一实际模型回合。[实例启停回执](final/mimo-receipt-browser-e2e.json)18/18 项通过，[启动](final/mimo-receipt-start.png)和[停止](final/mimo-receipt-stop.png)画面分别显示登记来源、状态和核对时间；同一隔离测试实例各操作一次，最终无容器。 | 验收当时 31893 业务实例运行；提交前复验时隔离数据根无实例登记。新 Research Run 仅覆盖 `U-INS-003` 一个 Case，未请求完整 AI review。未执行批量写入。 |
| 统一网关 | [桌面](final/final-page-gateway-1440.png) · [手机](final/final-page-gateway-390.png) · [最新概览](final/gateway-overview-1440.png) · [最新手机访问配置](final/gateway-access-390.png) | 四视图页签与内容共用面板，草稿保存栏、离开和返回、键盘页签；[页签与布局回执](final/gateway-tabs.json)、[断点及主题回执](final/gateway-panel.json)、[操作记录](final/ops-flows.json)。重载 3091 后的[四视图复验](final/gateway-browser-report.json)46/46 项通过，覆盖 1440、900、390px，页面无错误或 5xx。 | [实机预检](final/mimo-gateway-e2e-audit.json)确认 3091 网关关闭，31893 目标未受信登记；未发送网关业务请求，尚无网关端到端回执。 |
| MCP 管理 | [桌面](final/final-page-mcp-1440.png) · [手机](final/final-page-mcp-390.png) · [连接测试后](final/mcp-checked.png) | 服务列表、详情、工具调试与组合入口；3091 专用本地服务发现 1 个工具、0 个资源、1 个模板，界面区分“规范已读取”和业务调用。[检查回执](final/mcp-check.json) | 本地服务只供界面验收，未证明真实外部 MCP 或业务任务通过。 |

原生“管理对话”沿用现有确认流程。[单次确认回执](final/mimo-lui-final-e2e.json)记录 MiMo-V2.6-Flash/high 会话中的 `023` 来源、端口和 off 模型提案，状态依次为 `awaiting_confirmation`、`running`、`completed`；[确认前](final/mimo-lui-before-confirm.png)与[确认后](final/mimo-lui-after-confirm.png)界面显示一次创建成功。该 31894 测试实例随后停止，HOME 保留；回执来自原生 Session 事件与实例 CLI 回读。

隔离 `023` 来源的[评测预检](final/mimo-eval-dry-run.json)明确选择 `U-INS-003`，当前 Xiaomi 连接变量齐备。[真实 Run 回执](final/mimo-eval-real-summary.json)8/8 项通过：`run-8256cf6f-5e0f-4ec3-8420-0bff47423bf0` 的目标与 Judge 均实际使用 MiMo-V2.6-Flash/off，单 Case 1/1 通过、来源校验相符，评测实例已停止。完整 AI review 未请求；这个结果只覆盖所选 Case，不构成来源版本的完整业务评测或 Research Release。

## 生成与比较、模型设置

“生成与比较”以 `/home/admin/Downloads/Harness_算力变体策划_交互原型.html`（SHA-256 `2c4a21985a9489a6746ae5cb53e9e55a25930ed5bd6e84f1cd03fc3171e58e3e`）为交互参考。中算力配置覆盖轨迹样本、决策模型基模型、训练 SSH 与 LangGraph 工具；低算力配置覆盖轨迹到 LangGraph 代码模拟。两类请求都保留所选 Agent、版本与真实 Run 身份。[桌面亮色](final/compute-latest-desktop-light-page-full.png)、[手机亮色](final/compute-latest-mobile-light-page-full.png)、[桌面暗色](final/compute-latest-desktop-dark-page-full.png)及[手机暗色](final/compute-latest-mobile-dark-page-full.png)为当时构建的实际页面截图。[首次浏览器验收](final/compute-acceptance.json)153/153 项通过；[后续复验](final/compute-latest-acceptance.json)103/103 项通过，覆盖两类路线、真实 Run 多选与业务结果、训练连接保存回读和 SSH 标识探测、业务可用模型筛选、桌面及 390px 亮暗主题。[手机布局复验](final/compute-mobile-final-recheck.json)18/18 项通过，确认选择卡片和轨迹选项位于固定页脚上方；[选填区与草稿复验](final/compute-advanced-final.json)5/5 项通过。计划读取中或失败不会显示空计划与无 Run 的结论；比较摘要区分资源证据不足和目标未达标。目标 Agent 只有一个版本，跨版本草稿隔离未在真实页面执行；隔离数据没有已保存的策划计划和变体比较 Run，因此相应结果页尚无真实浏览器态验收。

[前次助手交接](final/compute-assistant-handoff.json)记录弹窗关闭、平台 AI 助手浮窗打开及版本和 Run 进入请求。本轮从真实 Run 发出一次低算力策划请求，[交接画面](final/mimo-low-compute-handoff.png)与[原生 Session 轨迹](final/mimo-low-compute-local-trace.json)6/6 项通过：MiMo-V2.6-Flash/high 回合完成，17 次工具调用均为只读，回复明确近似等效仍待验证。[完成后页面回看](final/mimo-low-compute-gui-readback.json)5/5 项通过，[截图](final/mimo-low-compute-gui-answer.png)确认同一答复在管理对话和平台 AI 助手浮窗可见。该 Run 仅覆盖一个 Case；本轮没有创建算力变体、执行训练或新增比较 Run。

原生“设置 → 模型”共用 DSH 模型目录，提供“平台 AI 助手”和“业务智能体统一默认”两个设置面板。平台助手可从目录选择任一模型；业务统一默认仅从当前可供业务实例使用的模型中选择一个，保存新选择会替换旧选择。新建实例预选统一默认；单个实例可另选模型，已有实例继续使用各自登记的默认模型。目录和连接状态在同一界面核对；缺少业务连接配置时可保存默认选择，实例预览会说明阻断原因。[模型草稿复验](final/model-draft-browser-report.json)13/13 项通过：反复打开无虚假冲突或未保存提示，真实草稿在重新打开后保留、放弃后恢复已保存值。[当前设置回读](final/mimo-model-settings-final.json)5/5 项通过，平台默认是 MiMo-V2.6-Flash/high，业务统一默认是 MiMo-V2.6-Flash/off，[桌面](final/mimo-model-settings-final-1440.png)和[390px](final/mimo-model-settings-final-390.png) 页面无错误。平台[新 Session](final/mimo-platform-native-session-final.json)8/8 与业务实例[新 Session](final/mimo-business-native-session-final.json)9/9 均完成非空回复，原生轨迹中的实际模型路由与设置一致。先前的[设置截图](final/model-settings-desktop-platform-saved.png)和[浏览器回执](final/model-settings-acceptance.json)对应当时的逐智能体标记界面，不作为当前界面的验收证据。

## 视口、主题和验证

六页分别核对 1440×1000、1366×768、901/900/899×1000 与 390×844 的实际加载视图。[断点记录](final/breakpoints.json)对应截图 `final/<页面>-<宽度>x<高度>.png`；全部页面没有页面级横向溢出或脚本错误。六页还通过 DSH 真实主题切换检查桌面和手机暗色状态及刷新保持，[暗色记录](final/dark-theme.json)对应 `final/<页面>-<desktop|mobile>-dark.png`。Chrome 实际 200% 缩放后，六页标题可见、无页面级横向溢出，并打开和关闭实例创建区；[缩放记录](final/zoom-200.json)对应 `final/<页面>-zoom-200.png`。其他 200% 操作路径尚未逐项验收。

评测页在 1440、1366、900 和 390 宽度展开平台助手，核对过滤器、结果列、全局退出、手机输入区与收起后焦点；网关保存/放弃操作在 1440、1366 宽度可触达。原生管理对话仅核对进入、返回和可见性。实际页面 [28/28 项回执](final/assistant-avoidance.json)和[手机助手截图](final/assistant-evaluation-assistant-open-390x844.png)无页面错误或 5xx；真实手机软键盘仍未验收。

最终重载 3091 后的[六页桌面和手机逐页检查](final/final-six-page-report.json)38/38 通过，保存内容读取完成后的 12 张实际页面截图，核对路由、内容、横向溢出及原生管理对话入口；页面无脚本错误或 5xx。[前一轮检查](final/latest-six-page-smoke.json)12/12 保留为当时证据。提交前从最终源码恢复 3091 后，[六页桌面和手机复验](final/final-six-page-after-restore-report.json)42/42 通过，12 张页面截图保存在同目录 `restore-page-*.png`；[实例桌面](final/restore-page-instances-1440.png)和[手机](final/restore-page-instances-390.png)空态与当前 CLI 0 条登记一致，页面无脚本错误或 5xx。插件全量测试 **775/775**、dsh-dev/dsh-eval 153/153、平台启动器 34/34 与最终构建通过。[实例 CLI 回读](final/mimo-cli-e2e-summary.json)6/6 项通过，确认隔离 `023` 来源、统一默认模型和 31893 实例的端口及 HTTP；新 Run 的预检与结果以上述独立回执为准。上表只列出 `UI-AC-01` 至 `UI-AC-24` 中已经验证的切面。运行中 Job、网关业务调用、双会话冲突、手机软键盘、完整键盘路径、全部 200% 操作，以及更多 Case 与完整 AI review 仍需对应对象的真实联调；截图、Mock 服务与合同测试不替代这些 R 层结论，`PA-12` 一级状态保持“部分验证”。
