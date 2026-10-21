# 21｜统一网关与 MCP 控制实施验收

2026-10-19 起在 `feat/PLATFORM-gateway-mcp-control` 实施即时任务的统一访问与执行控制。2026-10-21 的平台管理入口为 [18120 统一网关](http://10.0.160.32:18120/hep/#/gateway)，业务用户入口为 `http://10.0.160.32:53105/`；下文的 3090 端口、PID 和停止命令均为历史验收定位。源代码、状态合同和范围分别由 [20](20_业务访问与运行控制插件开发规范.md)、[03](03_存储架构与数据契约.md#business-access-data) 和 [05](05_实施路线与迭代计划.md#business-control-route) 维护，本文只记录实施与验收结果。

## EXP-024 融合与 MCP 迁移实机核对（2026-10-21）

本轮在程序和数据工作区的 `feat/AGENT-security-operations-expert-fusion` 分支实施，尚未提交、推送或创建 Tag。只读盘点 `/home/admin/Downloads/ai-agent-harness-main` 后，将旧并行版本仍有效的调度说明、应急防火墙、结构化目标与研判报告资产融入 `EXP-security-operations-expert-024-rad80a907c628` 的 Candidate，保留当前版本的 MCP 分组 v2、受控身份与既有证据合同。此处的来源与合同检查不能代替相应业务 Case 的执行结果。

| 核对对象 | 2026-10-21 的观察 |
|---|---|
| 平台与端口 | 原 3090 平台已停止；使用原数据根和平台账号重新 `prepare` 并在 18120 装载系统全局 DSH `0.2.1-rc.2`，业务网关仍监听 53105。实例默认端口按占用从 18500–28999 选择；本轮实例曾分配 18500、18501、18502、18503、18505，其中首次诊断实例 18500 已停止。 |
| 固定来源与实例 | 首次诊断实例 `security-operations-expert-fusion` 绑定当时 EXP-024 的来源 ID 和摘要，复用标准镜像 `ai-agent-harness/dsh:687f282e8-b9bce5f1fe5f`，使用独立 HOME；同名重启仍使用 18500。旧 EXP-021 实例与 HOME 保留。后续 Candidate 能力修订需要新的来源摘要和实例回执。 |
| 业务入口 | 网关曾使用 `/agents/security-operations-expert/instances/security-operations-expert-fusion/` 精确定位首次诊断实例。Mock 用户登录后，真实 DSH Web 完成引导、工作区登记和新 Session 创建，`session/list` 回读该 Session；浏览器无页面脚本错误。重启后短暂的 503 随实例回执建立而恢复，不作为长期可用性证明。 |
| MCP 管理 | 旧“`MCP配置管理`”中的服务与分组迁入数据根唯一配置 `config/mcp-manager.json`，当前保存 14 个服务、4 个分组，其中 12 个服务启用；凭据仍由本地忽略文件管理。18120 的真实“`MCP 管理`”页面显示 15 项服务，其中一项是已发布组合的只读投影；选择 `mock-threat-report` 并执行“发现工具与资源”后看到 `save_persistence_result`。列表中的 `mock-soc-readonly` 已按参考原型调整为卡片式条目，但显示真实连接状态“连接待检查”；见[桌面截图](../../platform/plugin/test/evidence/mcp-reference-card-20261021-desktop.png)和[窄屏截图](../../platform/plugin/test/evidence/mcp-reference-card-20261021-mobile.png)。这证明页面、管理接口与该 Mock 服务的发现链，不证明私网 SOC 上游可用。 |
| 开发调试入口 | `test-daily-inspection-assistant` 在 18501 以开发调试、需个人登录模式创建。其 Candidate 没有 MCP 种子，启动器改为保留 DSH 原生装载，消除此前“业务来源缺少 MCP 配置种子”导致的创建失败；真实网关登录后可创建并回读 DSH Session。`security-operations-expert-fusion-v2` 在 18502 以开发调试、匿名模式创建，访问链接仍经 53105 网关；后续 Candidate 更新后，新摘要由 `security-operations-expert-fusion-v3` 在 18505 装载，原 v2 的固定来源登记保留。开发实例不要求发布身份签名，但来源固定、网关至 Runtime 的签名通道和现有用户访问规则继续生效。 |
| 普通聊天与 MCP 故障 | 安全运营实例的私网 MCP 连接在本环境不可达，首次 `session/create` 报 `fetch failed`。受管 MCP 自动挂载已改为按来源容忍连接与发现失败，不登记不可用工具；DSH 原生 MCP 桥沿用原生启动失败容错。重建并重启后，匿名浏览器经网关创建 Session、发送问候、收到完成的中文回复，另一个访客不能读取该 Session，浏览器无脚本错误。该结果只证明普通聊天，不证明安全运营业务能力。 |

### 业务实例固定工作区与选择入口整改

`daily-inspection-assistant/tt` 的 HOME 中没有已登记工作区，虽然固定目录存在，页面首次打开仍显示“无法创建默认工作区，请通过选择工作区”；点击后 `directoryPicker/list` 返回 403。锁定版 DSH 的 `ui-workspace` 在工作区与 Session 均为空时调用 `workspace/initializeDefault`，尝试建立其通用默认目录；受管业务实例只允许服务端固定工作区，因此该请求和后续目录浏览都被现有访问规则拒绝。403 符合固定工作区边界，但页面把不可用的手动选择显示为恢复办法。已有 HOME 中登记过工作区的实例可避开首次初始化分支，不能据此认定其他业务智能体没有同一问题。所有受管业务实例使用共用的业务 Profile，空 HOME 时均受该路径影响；当前实机复现对象仅为 `tt`。

共用业务 Runtime 现于开放连接前调用 DSH 原生 `workspaceRegistry.create` 登记配置中的固定目录，重复登记保持同一工作区；登记失败则明确报错并不开放业务连接。业务 Profile 停用 DSH 的 `ui-agent-preset` 与 `directory-picker` 入口，保留原生 `workspace`、`workspace-controller`、`ui-workspace` 和 `ui-conversation`，并仅在业务会话内容区隐藏仍由 `ui-workspace` 绘制的“选择工作区”按钮。服务端固定 Preset、工作区和 Session 归属校验继续生效，`directoryPicker/list` 仍应拒绝业务访客。普通研究实例的手动选择流程不受这份业务 Profile 影响。

[空 HOME 回归](../../platform/plugin/test/business-gateway.test.mjs)覆盖启动前登记、重复登记、固定工作区创建 Session、目录浏览被拒和登记失败不开放连接；[Profile 回归](../../platform/plugin/test/business-ui-patch.test.mjs)核对锁定版 DSH 插件 ID、选择入口关闭及原生导航保留，两项定向测试合计 27/27 通过。

实机重载前，`tt` 的 `workspace.json` 中 `workspaceIds=[]`；重启后 DSH 原生 Registry 只有 `/work/harness/workspace` 一项。经 53105 网关首次打开 `tt` 为 HTTP 200，页面自动选中固定工作区，没有脚本错误，也没有 `workspace/initializeDefault` 或 `directoryPicker/list` 请求。`test-daily-inspection-assistant`（18501，个人登录）和 `security-operations-expert-fusion-v3`（18505，匿名）经网关浏览器完整加载后，三台实例均未显示“选择工作区”或“选择预设”，模型按钮仍可用，页面无脚本错误；浏览器在 28 秒观察窗口结束时确认后两台页面已完成加载。见 [`tt` 页面](../../platform/plugin/test/evidence/business-ui-tt-20261021.png)和[安全运营页面](../../platform/plugin/test/evidence/business-ui-security-operations-expert-fusion-v3-20261021.png)。v3 装载 EXP-024 新来源摘要 `sha256:b3bbbea7814eddfa9deea4cb7d8e08710d5a486a0d3ce6c53edbaa9c4884c20f`；v2 绑定旧摘要，未强行用新 Candidate 重启。

整改后又经 53105 网关对 `tt`（18503）和 v3（18505）执行 DSH 会话与普通对话：v3 的匿名访客 Cookie 下，`workspace/create` 返回固定工作区 ID，`session/create` 成功，中文问候被接受，`assistant/message` 返回正常的安全运营介绍，`turn/end` 为 `completed`；同一访客可从 `session/list` 读回会话，另一匿名访客不能列出，访问该会话页面返回 403。`tt` 以同一路径完成普通日检问候，回合结束为 `completed`，访客隔离同样有效。随后在两台实例的真实浏览器编辑器分别发送一条问候，`session/prompt` 均返回 200、回合均完成，回答在页面可见且无脚本错误；见 [`tt` 聊天页面](../../platform/plugin/test/evidence/business-chat-tt-20261021.png)与[安全运营聊天页面](../../platform/plugin/test/evidence/business-chat-v3-20261021.png)。这证明两台实例的新 Session、普通聊天界面与归属边界在网关下可用。

三台实例的浏览器检查证明受管业务 Profile 在 `tt` 空登记 HOME 与另外两台实例上的页面行为。静态审计了数据仓六个当前 Agent 的有效 Candidate：除安全运营专家外，另外五个没有专用工作区或预设界面；安全运营专家的专用界面也没有再创建这两类选择入口。六者的新受管实例均走同一业务 Profile；其余尚未创建实例的 Agent 仍只有源码与机器测试结论，未逐一实机检查。v3 与 `tt` 的普通对话结果不证明安全运营或巡检专项业务能力；私网 `172.16.138.232` 属于隔离部署测试环境，本机不做其联通性或专项业务验收。

v3 页面另显示“语音连接不可用，请重新启用插件”。受管网关当前未开放 `voiceMode/follow`，该提示所涉语音路径不在本次普通聊天验收内；语音订阅在锁定版插件中按广播发送，不能仅为消除提示而开放访问。此现象不影响上述文本对话结果，后续若要求语音可用，需单独核对会话归属和网关接入。

旧 Candidate 的 `sec-ops` 与 `inspection` 私网目标在本机连接超时。联调曾只在平台 MCP 配置的这两项连接上暂时改接已有 Mock 接口，保持服务 ID、工具范围和凭据字段，通过新业务 Session 验证装载；测试后已将当前配置和凭据恢复到联调前摘要。本次 Mock 只证明隔离外部依赖后的技术链路，真实 SOC 查询、回写及报告效果尚未验证。

DSH 原生 Schedule 已提供任务存储、定时器、Session 绑定和恢复机制；本轮核对锁定版公开接缝后，仍缺少受控业务模式所需的投递前授权重验和按用户过滤任务目录的完整接入点。因此当前受控 Profile 不启动 Schedule 服务、工具与页面，不另建调度器；旧研究实例保留其原生任务。无人值守巡检与定时报表的缺口、影响和后续完成条件仍由 [05 的首期定时任务边界](05_实施路线与迭代计划.md#首期定时任务边界与影响)维护。

## 2026-10-19 初次交付与部署

2026-10-19 初次部署时，统一网关进入平台一级导航，与 MCP 管理并列；MCP 工作区保留跳转。页面复用平台主题，提供顶部状态概览、四项功能配置切换和运行观察工作区。认证配置的是 Agent 的认证方式，信任判断针对 Agent 本身，风险由业务事件自动评估，访问授权维护服务和操作的访问控制策略；用户登录另列辅助配置。

2026-10-20 的[分类整改与 3090 实机复验](../../platform/plugin/test/evidence/gateway-classification-20261020/README.md#3090-实际生效验证)已将当前界面改为三类，移除 MCP 内重复的统一网关按钮，顶部一级入口继续使用；当时的进程与日志定位见该记录。下文四项界面及原服务 PID 保留初次验收的历史事实。

同日后续的[智能体选择器与紧凑状态栏验收](../../platform/plugin/test/evidence/gateway-selector-ui-20261020/README.md)已在 3090 生效：智能体从现有资产列表搜索选择，页内重复大标题移除，状态区改为紧凑摘要。当时的 3090 运行定位见该记录；同日 Mock 接入见后节。

2026-10-19 初次验收时，3090 所用数据工作区尚无业务网关配置，页面展示关闭、未接入与尚无评估。独立验收环境使用固定数据快照、独立 HOME 和标准 DSH 镜像，在真实平台、Runtime、模型及 MCP 调用之间验证控制；外部身份、风险与设备服务由 Mock 提供。业务 Candidate 没有为通过验收而放宽角色或工具限制。

| 对象 | 实际范围 |
|---|---|
| 程序分支 | 验收时位于 `feat/PLATFORM-gateway-mcp-control`，尚未提交、合并或推送 |
| Mock 分支 | `feat/PLATFORM-gateway-control-mock`；未提交、合并或推送 |
| Runtime | DSH `0.2.1-rc.2`，锁定提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；复用标准镜像，无派生镜像 |
| 验收数据 | 数据仓库提交 `06ebaef9789e36a7a322a81b30eb503f6da63052` 的独立快照 |
| 固定业务 | `security-operations-expert`，`EXP-security-operations-expert-021-rdd331f9f2e30` |
| 验收实例 | `soc-business-control`，私有回环端口 53103，独立 bridge 与 HOME，程序和资产只读挂载 |
| 验收平台 | 53104，独立管理 HOME；业务入口使用不同来源的 53102 |
| 真实模型 | `deepseek-official/deepseek-flash`；成功调用按固定角色允许的巡检路径执行 |

3090 原先固定的业务扩展构建产物继续装载。数据仓库存在本任务开始前的未完成修改，普通启动器会提示扩展源码尚未匹配当前构建；本次重新加载原启动命令和原 Profile，仅更新本任务的平台程序制品，没有据此重建或采纳并行修改中的扩展。

## 2026-10-19 已验证的即时任务闭环

| 场景 | 实际观察与证据边界 |
|---|---|
| Agent 认证与信任 | 中心验证 Runtime 的真实 HMAC 签名，显示当前代次、来源摘要及有效签名证据；建立真实快照回执后才显示可信。HMAC 证明同一受信部署域内的通道身份，不代表第三方行为认证。 |
| 信任配置实际生效 | 管理 GUI 取消信任并保存后，认证仍显示已验证，信任明确撤销、业务直达 503 且无页面正文；恢复信任并保存后，同一用户凭据重新访问为 200。没有改来源固定值或用户认证。 |
| 双用户会话 | A/B 在同一 Runtime 建立各自 Session，实际固定工作目录与 Preset；自己的历史可读，A 读取 B 的 Session 被拒绝。 |
| 真实只读调用 | A/B 经真实模型执行固定角色允许的 `inspection.list_executable_inspections`；Mock 目标账本记录对应用户标签，自动操作风险事实带 Agent、实例、代次、Session 和服务范围。 |
| 范围化风险收紧 | Mock 仅将 A 的写动作设为高风险。A 的 `start_inspection` 在派发前被拒绝，目标零新增；B 同一动作成功，受限 A 仍可只读。 |
| 风险恢复 | 清除 A 的外部风险后，同一 Session 的下一次新操作自动重评并成功；此前拒绝的动作没有自动重放。 |
| 首次写入确认 | 新 Session 经真实模型产生确认项后等待 1.2 秒，跨过中心心跳；确认前目标零新增，B 无待确认项且代答 403，A 本人回答 200 后目标恰增加一次，重复回答 403。 |
| 受控报告 | 显式将 `inspection.get_inspection_result` 配置为发布动作，输出地址改写为有 Session 归属的网关下载入口；A 下载 HTML 成功，B 同地址被拒绝且没有报告正文。 |
| 报告撤权与恢复 | 仅收紧 A 的发布权限后，A 下载被拒绝且上游下载账本零新增；清除风险后同链接恢复，B 仍被拒绝。下载还独立核对实际 GET 目标、当前连接、风险和正文。 |
| 管理页面 | 3090 使用原账号打开一级统一网关与深链；页面未配置时返回真实空状态。配置与轮询共用后端事实，慢响应期间不重复发起读取导致结果持续被丢弃。 |
| 原生业务页面 | 实际进入固定工作区、打开本人历史并从编辑器发送只读消息；真实模型完成巡检目录查询，目标 A 读计数由 3 增至 4，页面显示完成且消息流结束。不是仅检查非空页面或 HTTP 状态。 |

精简实机结果与截图见[证据目录](../../platform/plugin/test/evidence/business-control-20261019/README.md)。原始模型轮次、账本、启动日志和部署定位原保存在本机 `.local/business-control-acceptance/`，2026-10-20 已移至 `/home/admin/harness-engineering-platform-backups/state-cleanup-20261020-Vl9YYs/business-control-acceptance/`；其中凭据文件不入仓、不进入截图或普通证据。

最终平台全量测试 **586/586** 通过；启动器与业务启动测试 **132/132**、业务渲染 **4/4**、Web 适配器 **13/13**、Mock **149/149** 通过。最终构建、TypeScript 检查和仓库合同校验通过，文档链接与凭据值扫描未发现本轮问题。上述检查验证实现合同，不替代外部真实业务或研究效果。

### 初次验收服务定位（2026-10-19）

以下保留初次验收结束时的本机定位；2026-10-20 的 3090 Mock 接入及当时运行定位见后节。

| 服务 | 地址或实例 | 进程与日志 | 按需停止 |
|---|---|---|---|
| 用户平台 | `http://10.0.160.32:3090/hep/#/gateway` | PID `1882073`；`.local/business-control-acceptance/main-3090.log` | `kill -TERM 1882073` |
| 独立联调平台与业务网关 | `127.0.0.1:53104/hep/`；`business.localhost:53102/` | PID `1884768`；`.local/business-control-acceptance/platform.log` | `kill -TERM 1884768` |
| 外部 Mock | 宿主 bridge 地址的 53101 端口 | PID `1713887`；`.local/business-control-acceptance/mock-service.log` | `kill -TERM 1713887` |
| 业务 Runtime | `soc-business-control`；私有 `127.0.0.1:53103` | `.local/business-control-acceptance/runtime-start.log` | 在程序根执行下方命令，保留 HOME |

```bash
HARNESS_ASSET_ROOT="$PWD/.local/business-control-acceptance/data" \
  /usr/bin/python3 runtime/adapters/dsh-container/dsh-dev \
  --repo "$PWD/.local/business-control-acceptance/data" down soc-business-control
```

上表及命令保留初次验收时的定位。2026-10-20 已停止独立联调平台和 `soc-business-control`，删除该实例登记并保存 HOME；旧 PID 与原路径不再用于当前操作。

## 原生接入与边界修正

业务 Profile 停用默认 owner 连接与未纳管的 Shell、文件、调度等入口，使用真实非 owner Peer 与原生 RemoteAccess 约束。业务 Host 薄入口位于独立包，避免 Loader 将完整管理客户端误装入业务页面；通过隔离的原生 Node 客户端面保留真实浏览器连接模块，没有复制 DSH 客户端或启用默认 owner Host。

原生会话分页与跟随使用 `request.address`，在共同解析边界验证本人 Session；原生事件通道只允许已授权资源。固定工作区注册按实际原生 `path` 合同收束为服务端固定目录，返回 Session 列表按归属裁剪。会话创建使用真实固定工作区 ID，并为该资源补齐创建所需的精确授权，其他工作区仍拒绝。代码及回归覆盖不自动代表每个原生工作台功能都已业务验收。

确认适配器优先处理自身绑定的原生 `ApprovalService` 请求，不让它等待 owner 专用交互通道。首次检测产生的事实先由中心接收，Runtime 应用相应快照后才冻结并展示确认；已有心跳只含旧事实时，必须再完成一次包含本次事实的同步。展示后的身份、参数与版本仍严格重验；初版跨心跳后返回 409 的失败记录保留，没有通过放宽版本约束解决。

冷加载还暴露了共同性能根因：Web 适配器在主线程同步解析大型插件包的 TypeScript AST，控制心跳因而延迟，2 秒许可按约失效。转换改在一个可复用 Worker 中运行，仍调用同一转换器，并对同一资源复用待决结果；卸载时终止 Worker。相同 8 个并发资源请求在修复前全部 503，修复后全部 200、每个 741,114 字节，耗时约 0.388–0.408 秒，没有放宽许可租期。新增回归验证大型转换持续 2.25 秒时，控制 HTTP 仍可及时响应。

实际联调保留了失败：首次业务客户端缺少原生连接模块导致启动失败；未声明工具依赖导致 Session 创建失败；风险请求多带内部字段导致提供方返回 422；冷启动与重启期间出现短暂 503；外部风险记录到期时按约拒绝。对应根因修正或重新取得有效事实后再验证，失败不改写成成功。

## 未覆盖范围

首期不支持定时任务的检测、防护闭环。新业务 Profile 不启动定时服务、工具与页面；原研究实例及历史任务仍按原方式运行，不能计为本闭环已保护。人工发起增加操作成本，离线无人值守巡检、自动研判和定时报表存在延迟或漏执行，空闲期间没有周期风险检测。后续开放的投递前授权与恢复条件见 [05](05_实施路线与迭代计划.md#首期定时任务边界与影响)。

本次结果属于 `PA-05/06/08/12` 的项目与工具链验证：真实平台与 Runtime 使用模拟外部提供方验证所选即时任务链。不证明企业身份互信、真实设备处置、所有工具或任意插件网络请求均受保护，也不替代 Harness Experiment Evaluation、Research Release 或生产验收。未验证其他终端的局域网连通、TLS、长期无人值守、业务子 Agent 全链及另一业务的完整复用。

原生业务页面的 owner 管理、语音、Skill／命令目录和运行概览辅助接口未开放，对应组件可能显示不可用；本次验证范围是受管 MCP 的即时会话与选定产物，不能表述为完整 Candidate 全部功能已通过。独立 fixture 已清除测试风险限制并恢复 Agent 信任，巡检发起保留必要确认，报告查询明确按发布操作授权。

## 2026-10-20 的 3090 Mock 接入

当时数据工作区的唯一业务访问配置为 `/home/admin/harness-engineering-platform-data/config/business-access.json`。3090 的“统一网关”页面已读取该配置：接入用户验证、身份信任及风险评估指向独立 Mock service `172.17.0.1:53101`，Agent 来源固定为 `EXP-security-operations-expert-021-rdd331f9f2e30`。业务用户从 `http://10.0.160.32:53105/` 登录，再进入 `security-operations-expert`；3090 是当时的平台管理员配置入口，不代替业务用户入口。业务 Runtime 为 `security-operations-expert-business-mock`，宿主只开放回环端口 53107，使用原标准镜像和独立 HOME。

登录测试凭据在数据根的 `.local/business-control-mock/fixture-credentials.json`，文件权限为 `0600`，分别对应 `subject-a`、`subject-b`；凭据原值不进入业务配置、文档或验收记录。Mock 凭据最长有效一小时，到期后在宿主机运行 `node /home/admin/harness-engineering-platform-data/.local/business-control-mock/refresh-fixture.mjs` 轮换，再使用文件中的新凭据登录。Mock 进程重启会清空内存 fixture，该命令也会重新创建 fixture。业务 Session 仍由 Runtime 保存，但续用时需要重新验证当前凭据。Mock 服务与临时凭据只用于本地联调。

本次实际验证：3090 登录后页面显示测试模拟提供方，实例签名与回执稳定后均为 `1/1`；A/B 凭据均可进入业务入口并创建真实 Session，匿名与无效凭据被拒绝，A 读取 B 的 Session 返回 403；固定标记 `MOCK_CONTROL_DENY_INPUT` 在模型执行前返回 403，并形成高风险事实。只开放 `inspection.list_executable_inspections` 这一项只读 Mock 操作；B 经真实模型完成调用，Mock 目标账本记录 `subject-b`、`mcp:inspection`、`finished/succeeded`，控制中心记录对应低风险事实。浏览器打开 B 的历史会话，能看到返回的“基础资产健康巡检”且编辑器可用；轮换凭据后仍可读取同一 Session。原候选资产中的 `sec-ops` 和 `inspection` 初始地址已不可达；仅该实例的运行配置改接 Mock MCP，不修改 Candidate 或其来源摘要。`sec-ops.search_graph_assets` 的主 Agent 直调被角色 Guard 拒绝，因此未作为开放操作。

实例管理入口的后续[实机复验](../../platform/plugin/test/evidence/instance-gateway-web-20261020.json)修正了访问地址合同：业务实例的 53107 是内部 Runtime 端口，`dsh-dev url` 返回的是已登记网关 53105 的 Agent 深链；平台按同一配置核对完整公开地址，不再要求两端口相等。匿名浏览器打开该深链仍返回 401，但显示可操作的个人登录表单；使用本地 Mock 用户登录后直接进入原深链的 DSH Web。3090 的表格和详情按钮均已点击验证，页面注明“经业务网关”，源页面保留，浏览器页面错误为零。普通实例继续校验本机实例端口；业务实例内部地址、错误网关地址和未登记入口均被拒绝。业务登录仍使用前述临时 Mock 凭据。

冷加载 3090 管理页时曾短暂显示签名与回执 `0/1`，业务入口同期返回 503；后续轮询恢复 `1/1`，网关连续访问返回 200。模拟风险事实有短有效期，空闲时页面可能显示“评估已过期”，下次受控输入或操作会重新评估。本次没有证明长期持续可用。

当时的进程及本机证据位于数据根 `.local/business-control-mock/`；3090 日志位于数据根 `.local/logs/main-3090-20261020.log`。当时记录的停止命令是 `kill -TERM "$(cat /home/admin/harness-engineering-platform-data/.local/business-control-mock/platform-3090.pid)"`，不适用于现运行的 18120 平台。本次只证明 Mock 身份、风险和指定只读业务调用；真实身份提供方、真实 SOC、其他工具、定时任务及生产网络部署未在此验收。

## 2026-10-20 的 3090 管理界面整改

在原 3090 Profile 和数据根重载插件后，[真实浏览器验收](../../platform/plugin/test/evidence/gateway-overhaul-20261020/README.md)确认统一网关以“运行概览、智能体身份、风险评估、访问控制”四视图运行：运行状态集中在概览，三类配置共用一份可跨页保留的草稿和一次保存入口。未访问的其他一级页面延后挂载，身份页的提供方 HTTP 探测在真实页面返回；`HTTP 405` 仅表明地址有响应，界面明确提示 POST 合同及业务结果未验证。当前资产描述只读显示已启用 Experiment 中发现的名称、描述和技能，不表示实例已装载。

访问控制中的“允许使用此 Agent 的接入用户 ID”维护基础许可；运行概览中的“要限制的接入用户”只选取已获准用户，支持多选并逐人建立限制。选中多位后不能附带 Session ID，辅助重评仍要求单个用户及 Session。浏览器只验证了选择、提示和禁用状态，未实际提交人工限制。草稿跨页保留、放弃恢复、390px 布局、页面错误及 5xx 响应均经检查；业务访问配置摘要未变。插件全量测试 **595/595** 通过，构建与 TypeScript 检查通过。当时 3090 的 PID 为 `2580356`，不用于当前 18120 平台的操作。
