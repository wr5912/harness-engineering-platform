# 21｜统一网关与 MCP 控制实施验收

本次在 `feat/PLATFORM-gateway-mcp-control` 实施即时任务的统一访问与执行控制。当前管理入口为 [3090 统一网关](http://10.0.160.32:3090/hep/#/gateway)，复用原平台账号、数据根和 HOME。源代码、状态合同和范围分别由 [20](20_业务访问与运行控制插件开发规范.md)、[03](03_存储架构与数据契约.md#business-access-data) 和 [05](05_实施路线与迭代计划.md#business-control-route) 维护，本文只记录实施与验收结果。

## 交付与实际部署

2026-10-19 初次部署时，统一网关进入平台一级导航，与 MCP 管理并列；MCP 工作区保留跳转。页面复用平台主题，提供顶部状态概览、四项功能配置切换和运行观察工作区。认证配置的是 Agent 的认证方式，信任判断针对 Agent 本身，风险由业务事件自动评估，访问授权维护服务和操作的访问控制策略；用户登录另列辅助配置。

2026-10-20 的[分类整改与 3090 实机复验](../../platform/plugin/test/evidence/gateway-classification-20261020/README.md#3090-实际生效验证)已将当前界面改为三类，移除 MCP 内重复的统一网关按钮，顶部一级入口继续使用；当时的进程与日志定位见该记录。下文四项界面及原服务 PID 保留初次验收的历史事实。

同日后续的[智能体选择器与紧凑状态栏验收](../../platform/plugin/test/evidence/gateway-selector-ui-20261020/README.md)已在 3090 生效：智能体从现有资产列表搜索选择，页内重复大标题移除，状态区改为紧凑摘要。当时的 3090 运行定位见该记录；当前 Mock 接入见本文末节。

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

## 已验证的闭环

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

以下保留初次验收结束时的本机定位；当前 3090 的 Mock 接入及运行定位见本文末节。

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

## 当前 3090 Mock 接入（2026-10-20）

当前数据工作区的唯一业务访问配置为 `/home/admin/harness-engineering-platform-data/config/business-access.json`。3090 的“统一网关”页面已读取该配置：接入用户验证、身份信任及风险评估指向独立 Mock service `172.17.0.1:53101`，Agent 来源固定为 `EXP-security-operations-expert-021-rdd331f9f2e30`。业务用户从 `http://10.0.160.32:53105/` 登录，再进入 `security-operations-expert`；3090 仍是平台管理员配置入口，不代替业务用户入口。业务 Runtime 为 `security-operations-expert-business-mock`，宿主只开放回环端口 53107，使用原标准镜像和独立 HOME。

登录测试凭据在数据根的 `.local/business-control-mock/fixture-credentials.json`，文件权限为 `0600`，分别对应 `subject-a`、`subject-b`；凭据原值不进入业务配置、文档或验收记录。Mock 凭据最长有效一小时，到期后在宿主机运行 `node /home/admin/harness-engineering-platform-data/.local/business-control-mock/refresh-fixture.mjs` 轮换，再使用文件中的新凭据登录。Mock 进程重启会清空内存 fixture，该命令也会重新创建 fixture。业务 Session 仍由 Runtime 保存，但续用时需要重新验证当前凭据。Mock 服务与临时凭据只用于本地联调。

本次实际验证：3090 登录后页面显示测试模拟提供方，实例签名与回执稳定后均为 `1/1`；A/B 凭据均可进入业务入口并创建真实 Session，匿名与无效凭据被拒绝，A 读取 B 的 Session 返回 403；固定标记 `MOCK_CONTROL_DENY_INPUT` 在模型执行前返回 403，并形成高风险事实。只开放 `inspection.list_executable_inspections` 这一项只读 Mock 操作；B 经真实模型完成调用，Mock 目标账本记录 `subject-b`、`mcp:inspection`、`finished/succeeded`，控制中心记录对应低风险事实。浏览器打开 B 的历史会话，能看到返回的“基础资产健康巡检”且编辑器可用；轮换凭据后仍可读取同一 Session。原候选资产中的 `sec-ops` 和 `inspection` 初始地址已不可达；仅该实例的运行配置改接 Mock MCP，不修改 Candidate 或其来源摘要。`sec-ops.search_graph_assets` 的主 Agent 直调被角色 Guard 拒绝，因此未作为开放操作。

实例管理入口的后续[实机复验](../../platform/plugin/test/evidence/instance-gateway-web-20261020.json)修正了访问地址合同：业务实例的 53107 是内部 Runtime 端口，`dsh-dev url` 返回的是已登记网关 53105 的 Agent 深链；平台按同一配置核对完整公开地址，不再要求两端口相等。匿名浏览器打开该深链仍返回 401，但显示可操作的个人登录表单；使用本地 Mock 用户登录后直接进入原深链的 DSH Web。3090 的表格和详情按钮均已点击验证，页面注明“经业务网关”，源页面保留，浏览器页面错误为零。普通实例继续校验本机实例端口；业务实例内部地址、错误网关地址和未登记入口均被拒绝。业务登录仍使用前述临时 Mock 凭据。

冷加载 3090 管理页时曾短暂显示签名与回执 `0/1`，业务入口同期返回 503；后续轮询恢复 `1/1`，网关连续访问返回 200。模拟风险事实有短有效期，空闲时页面可能显示“评估已过期”，下次受控输入或操作会重新评估。本次没有证明长期持续可用。

当前进程及本机证据位于数据根 `.local/business-control-mock/`；3090 日志已移至数据根 `.local/logs/main-3090-20261020.log`，当前进程的标准输出与错误输出仍指向该文件。停止 3090 可使用 `kill -TERM "$(cat /home/admin/harness-engineering-platform-data/.local/business-control-mock/platform-3090.pid)"`；停止本次 Mock 可使用 `kill -TERM "$(cat /home/admin/harness-engineering-platform-data/.local/business-control-mock/mock-service.pid)"`；停止业务 Runtime 可在程序根执行 `python3.10 runtime/adapters/dsh-container/dsh-dev --repo /home/admin/harness-engineering-platform-data down security-operations-expert-business-mock`。本次只证明 Mock 身份、风险和指定只读业务调用；真实身份提供方、真实 SOC、其他工具、定时任务及生产网络部署未在此验收。

## 当前 3090 管理界面整改（2026-10-20）

在原 3090 Profile 和数据根重载插件后，[真实浏览器验收](../../platform/plugin/test/evidence/gateway-overhaul-20261020/README.md)确认统一网关以“运行概览、智能体身份、风险评估、访问控制”四视图运行：运行状态集中在概览，三类配置共用一份可跨页保留的草稿和一次保存入口。未访问的其他一级页面延后挂载，身份页的提供方 HTTP 探测在真实页面返回；`HTTP 405` 仅表明地址有响应，界面明确提示 POST 合同及业务结果未验证。当前资产描述只读显示已启用 Experiment 中发现的名称、描述和技能，不表示实例已装载。

访问控制中的“允许使用此 Agent 的接入用户 ID”维护基础许可；运行概览中的“要限制的接入用户”只选取已获准用户，支持多选并逐人建立限制。选中多位后不能附带 Session ID，辅助重评仍要求单个用户及 Session。浏览器只验证了选择、提示和禁用状态，未实际提交人工限制。草稿跨页保留、放弃恢复、390px 布局、页面错误及 5xx 响应均经检查；业务访问配置摘要未变。插件全量测试 **595/595** 通过，构建与 TypeScript 检查通过。3090 的当前 PID 以数据根 `.local/business-control-mock/platform-3090.pid` 为准；本次实测为 `2580356`，停止命令沿用上节。
