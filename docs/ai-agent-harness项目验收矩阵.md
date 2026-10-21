# Harness 工程平台项目验收矩阵

更新日期：2026-10-21

本文是 **Harness 工程平台项目与工具链**验证路径、当前证据和缺口的唯一维护位置。它直接回答三个问题：总共有多少条路径、每条做到什么程度、哪些检查应该进入自动化测试。

## 1. 直接答案：共有 12 条一级验证路径

当前共有 **12 条一级验证路径**，编号 `PA-01` 至 `PA-12`。一级路径是用户可以独立完成、并且能够独立成功或失败的一条完整工作链；内部命令和正反向检查不重复计数。

2026-10-16 的[任务型智能体交付与验收](platform-design/17_任务型智能体交付与验收.md)补充 `PA-03/04/05/06/07/08/10/12`：能力发现与固定来源装配、一次任务确认、持久评测、最多三轮修复、暂停重启恢复，以及最终实例独立业务探针和实际报告下载。首页体验与新建智能体使用真实模型和基础 Mock 接口；研究案例使用固定官方文档快照；训练案例仅完成真实资源预检。失败、取消及超额停止均保留，不据此提升真实设备业务、训练效果、人员采纳或 Research Release 结论。实际结果、用户投入、调用统计及预算限制统一见该记录。

同日的[正式入口复验](platform-design/17_任务型智能体交付与验收.md#正式入口复验)补充正式 3090 平台、新建 3114 实例、报告下载和首页及六页布局证据。首次来源权限不符的拒绝与按冻结清单恢复后的成功分别保留；原 3081/3089 实例未变。本地精确恢复不等于通用权限迁移已经自动实现，原 Run 和上述验收层级保持不变。

2026-10-20 的[3090 Mock 接入实机验证](platform-design/21_统一网关与MCP控制实施验收.md#当前-3090-mock-接入2026-10-20)补充 `PA-05/06/08/12`：当前数据工作区已配置模拟用户认证、身份信任及风险提供方；独立业务实例沿用固定 EXP-021 来源和标准镜像，运行配置将两项 MCP 连接指向 Mock。A/B 真实 Session、跨用户拒绝、高风险输入拒绝、B 经真实模型完成一次只读巡检目录调用、Mock 账本与浏览器历史均已核对。测试凭据最长一小时且 Mock fixture 仅在进程内保存；真实身份源、真实 SOC、其他操作与生产网络仍未验证，一级路径状态不提升。

同日的[业务实例 Web 入口复验](../platform/plugin/test/evidence/instance-gateway-web-20261020.json)补充 `PA-05/12`：实例管理的表格和详情按钮均按登记的业务网关公开地址打开；未登录时显示个人登录表单，登录 Mock 用户后进入实际 DSH Web。页面将 Runtime 端口标为内部端口，并标明访问需经业务网关；普通实例原有端口校验保留。验收范围为当前 3090 与本机浏览器，不提升真实外部身份或生产网络状态。

2026-10-21 的[双架构部署整改与 AMD64 本机记录](../platform/plugin/test/evidence/dual-architecture-20261021/README.md)补充 `PA-05/06/12`：来源锁改为在受支持的 Linux 宿主选择 `linux/amd64` 或 `linux/arm64`，并将架构计入镜像身份；本机重新构建 AMD64 标准镜像，隔离平台完成登录和新 Session，六个 active Agent 分别完成镜像一致性、实例页面、新 Session 创建或持久回读及停止。安全运营语音插件首次因旧安装命令漏装锁定依赖而未激活，修正安装说明后完整插件导入与配置路由 200 通过；Chromium 在镜像内实际启动。平台模型轮次因提供方余额不足未取得回复，语音外部服务和各 Agent 业务任务未测；Ubuntu ARM64 实机尚未验证，三级路径状态均保持部分验证。

| 阶段 | ID | 一级验证路径 | 当前状态 |
|---|---|---|---|
| 准备 | `PA-01` | 项目定位、AI 协作入口与项目 Memory | 部分验证 |
| 准备 | `PA-02` | 规范来源、受控副本与适用范围 | 已验证（机器范围） |
| 准备 | `PA-03` | 仓库结构、项目技能与研究资产合同 | 已验证（机器范围） |
| 选择来源 | `PA-04` | Experiment 来源解析、被测身份与材料隔离 | 已验证（机器范围） |
| 启动 | `PA-05` | `dsh-dev` 实例完整生命周期 | 部分验证 |
| 装载 | `PA-06` | 被测容器的真实装载与只读边界 | 部分验证 |
| 修改 | `PA-07` | 宿主修改、装载观察与回退闭环 | 部分验证 |
| 交互 | `PA-08` | DSH Runtime API 与 Web UI 的 Session、消息与结果闭环 | 部分验证 |
| 派生 | `PA-09` | 新 Preset 创建、登记、重载与选择闭环 | 部分验证 |
| 记录 | `PA-10` | Research Run 的创建、记录、缺口与封存 | 已验证（机器范围） |
| 复用 | `PA-11` | Research Release 打包、解析与复现装载 | 未实现 |
| 平台 | `PA-12` | 全局 DSH 平台启动、认证与研究工具 | 部分验证；原六页、统一网关与全局启动分项已验证 |

状态含义：

- **已验证（机器范围）**：稳定、确定性的合同已有自动化正反向检查；不包含人工语义判断。
- **部分验证**：已有实现和局部证据，但完整用户路径、真实环境或异常分支仍有缺口。
- **未验证**：可能已有设计或局部实现，但没有足以确认完整路径的证据。
- **未实现**：完整入口尚不存在，不能靠补一条测试把它描述为可用。

这 12 条只统计项目与工具链，不把每个 Harness 的研究输入数量或每个 Release 的复现次数算进去。新增稳定 CLI、运行模式或独立用户流程时，先判断它是既有路径中的步骤，还是能独立成功或失败的新一级路径；只有后者才增加总数。

## 2. 三种结论必须分开

| 层级 | 回答的问题 | 主要证据 | 不能据此声称 |
|---|---|---|---|
| 项目与工具链验证 | 仓库规则、CLI、来源解析和 DSH 接入是否按设计工作 | 本矩阵、`tests/`、技术探针 | 某个 Harness 改动有效 |
| Experiment Evaluation | 某项 Harness 变化在声明输入和环境下表现如何 | 假设、Run、观察、回归、Decision | 整个工具链或其他 Experiment 都可用 |
| Research Release 复现 | 某个不可变研究版本能否恢复并重新装载 | Release 清单、摘要、复现记录 | 已满足生产部署、安全或运维要求 |

这三层都属于研究项目，不包含生产部署验收。未来若需要生产工程，应另行定义权限、安全、运维和发布合同。

## 3. 逐条路径

2026-10-16 至 17 日的[决策模型数据集审查与整改](platform-design/19_决策模型数据集整改.md)补充 `PA-03/08/10/12`：版本 2 的多题输入/监督分离、概率与实际来源校验、逐题复核、固定来源集合、跨批次关联分组及显式用途导出，配套管理助手 Skill 与方法同步修改。插件全量 477 项、后端/轨迹定向 38 项及资产合同校验通过。真实页面与模型的成功、拒绝及隔离环境范围统一见该记录；旧 Run、旧样本及正式服务不因本轮验收自动替换，行业真值、概率校准和训练收益尚未证明。

2026-10-16 的[完整闭环验收与恢复验证](platform-design/16_完整闭环验收与恢复验证.md)继续补齐 `PA-03/04/05/06/08/10/12`：固定父版 A/A 算力变体完成四次真实容器评测，重复不足与无资源改善均不能得到 `end`；确认后的助手写入、来源回读、私有 Git 初始化及恢复后迁移程序目录分别验证。首次 HOME 目录属主、包含缓存的输入 token 口径及助手来源与完成回执已按实机问题整改。业务链路、回归结果及限制统一见该记录，不将 A/A 验收描述为某项优化已近似等效，不提升真实 SOC 或 Research Release 结论。

2026-10-16 的[独立数据工作区与管理助手实施](platform-design/15_独立数据工作区与管理助手实施.md)补充 `PA-03/04/05/06/08/10/12`：业务资产与状态移至独立数据根，固定引用及旧 Session 保持可恢复；原生 MCP 配置身份迁移、真实已发布组合、管理助手特性与样本预览、固定父版读取、算力变体计划与比较合同，以及平台 `/hep/` 基址已核对。具体成功、失败与未验证项以该记录为准，不据此提升业务近似等效、真实 SOC 或 Research Release 结论。

2026-10-16 的[个人工作台与决策样本验收](platform-design/13_个人工作台与决策样本实施.md)补充 `PA-03/04/08/10/12`：真实 UI 创建基础示例 Agent、维护 Case、从 Run 转草稿、两次标准镜像/实际模型评测（2/2 与 3/3）、来源对照及 Decision 保存；Run 结构化阅读、固定 Baseline 差异、可复用 Skill 的受限 AI 抽取、逐条复核与 JSONL 下载、同 HOME 重启恢复。最终抽取会话实际仅使用指定 Skill 与平台取数，保留 2 条巡检候选，连同首轮 1 条均为待人员复核；原 Run 未改写。上下文为 reconstructed，未选 full 用例、人工真值、模型训练、TR02/TR03 与真实外部巡检均未在本轮证明，路径状态不据此全面提升。

同日后续[对抗审查与实机验收](项目对抗审查与实机验收_2026-10-16.md)覆盖 `PA-01/03/04/05/06/08/10/12`：整改样本题目时点、取消收尾临界窗口、Case来源丢失、实际模型路由比较和封存来源漂移；恢复失联Mock并通过原生MCP插件接入，业务Harness未改。示例full 4/4、真实容器取消与Run封存、最终Skill抽取2条及时点核对/导出、六页和只读组合、安全专家目录/续查/缺ID及基础事件快判已验证。累计7条候选中3条排除、4条待人员复核；训练效果、真实SOC、全部历史与远程报告访问未证明。最终256项插件、153项适配层、88项仓库及相关Node回归通过，具体边界和证据以该记录为准。

2026-10-15 的[项目对抗审查与实机验收](项目对抗审查与实机验收_2026-10-15.md)补充了 `PA-03/04/05/06/08/10/12`：新建随机后缀来源并保留历史身份，融合归档与当前能力；标准镜像干净生产依赖装载；平台真实 UI 重启保留同来源环境、HOME 和配置；六页、管理对话冷启动、不可变组合确认、凭据拒绝、报告及完整产物下载。新 EXP021 的基础 Mock 业务与实际模型摘要见其 [Evaluation](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-021-rdd331f9f2e30/evaluation/observations.md)。真实 TTS 不可达、完整研判输出校验失败、Mock 报告不保存原文、原 Case 输入未原样执行均保留为限制；这些证据不提升全项目路径为完全验证，不构成 Research Release 或生产验收。

2026-09-30 的 [EXP-010 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-010/evaluation/observations.md)补充了 `PA-04/05/06` 的 Candidate 来源、标准镜像、插件实际路由和评测实例启停证据；`PA-07` 观察到插件修复前后新 Session 的行为变化，尚无来源回退；`PA-08` 完成 7 个巡检 Case 的真实 API Turn，未完成浏览器巡检或真实 MCP 业务链；`PA-10` 封存两次完整 Run 并用 `run_record.py compare` 查证。外部巡检 MCP 拒绝连接，研究效果仍为 `inconclusive`，上述路径状态不因此提升。

2026-10-08 的 [EXP-011 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-011/evaluation/observations.md)补充了 `PA-05/06/08/10` 的独立镜像构建、真实 DSH Web 装载、桌面与窄屏浏览器交互、模型回复和浏览器 Run 证据；所选入口的结果和限制以该观察为准，不改变本矩阵的全项目路径状态。

2026-10-08 的 [EXP-012 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-012/evaluation/observations.md)补充了 `PA-04/05/06/07/08/10` 的来源、标准镜像、四工具实际注册和调用、Candidate 修改后新 Session、三个 Case 的真实 API Run、重复验证及同报告对照；[实例操作记录](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-012/evaluation/evidence/research-tool-instance-20261008.json)证明一个实例重启前后目标与实际镜像及只读挂载一致，错误实例名被拒绝。机器评审曾误判续查，新 Run 已经原始记录复核；[Decision](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-012/decision.md)仍是 AI 临时 `continue`，人类采纳、浏览器页面验收和稳定工具效率收益均未确认，路径状态不因此提升。

2026-10-09 的 [EXP-013 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-013/evaluation/observations.md)补充了 `PA-05/06/07/08` 的当前实例装载、三页 MCP 配置浏览器交互、实际 Web profile 保存和恢复、受控 MCP 分组端点调用及新 Web Session 模型回复证据。外部业务 MCP、语音和业务 Case 尚未验收，路径状态不因此提升。

2026-10-09 的 [EXP-014 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-014-r8b1bd54e8be7/evaluation/observations.md)补充了 `PA-03/04/05/06/08` 的融合来源、当前实例只读装载、MCP 授权与分组技术链路、浏览器新 Session、语音识别和播报证据。`ai_soc_*` 的 OpenAPI 规范未取得，业务 Run 未完成；路径状态不因此提升。

2026-10-10 的 [EXP-015 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r904bdcd81005/evaluation/observations.md)补充了 `PA-03/04/05/06/07/08/10` 的 Web MCP 配置回流、四服务工具发现与分组鉴权、同名实例重建、新 HOME 恢复和六个真实新 Session Case 的[封存 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r904bdcd81005/runs/run-d442726d-c74c-42f7-91c2-8bb881424c29/report.md)。巡检三项通过，故障分析一项无法判定，策略与应急各一项因上游结果未达业务预期而失败；修正巡检解析指令后又有[三项巡检补充 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r904bdcd81005/runs/run-da0a2cdb-f9e3-41eb-b4f6-c2b23a3dd017/report.md)，均通过。[跨版本对照 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r904bdcd81005/runs/run-7bc9d938-4522-4ea6-be33-5e2c04e19e11/report.md)与 EXP-012 的三个共同 Case 各为 3/3 通过，但 Case 口径和运行条件不同，且未验证本地 Qwen 组合。浏览器页面未在本次重验，全项目路径状态不因此提升。

2026-10-10 的 [EXP-015 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/evaluation/observations.md)补充了 `PA-04/05/06/08/10` 的新来源、隔离实例、三工具实际发现、非零实例概览和六个巡检 Case 的真实 API Run。常规巡检与两轮续查有工具回执；周期任务创建失败，指定资产结果查询有服务端错误，同路由模型自动评审仍需人工判读。平台身份链和浏览器业务路径尚未验收，路径状态不因此提升。

2026-10-11 的 [EXP-015 浏览器补充观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/evaluation/observations.md)为 `PA-08` 增加同一实例的目录查询、同 Session 两轮续查和概览→MCP 配置→业务对话的连续试跑，保存页面回答及原始工具轨迹。简化后的浏览器执行器在两个新 HOME 的正式 Run 中完成目录查询 UI 冒烟；新增失败 Run 定位在工作区连接阶段。浏览器结果不能代替 API 业务判定或跨实例平台身份链验收，路径状态不因此提升。

2026-10-11 的 [EXP-016 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-016-r77d4eb1119fb/evaluation/observations.md)补充了 `PA-06/07/08/10` 的可配置语音摘要插件实际装载、共用连接、取消与重连、历史冷加载及无插件/卸载浏览器证据。保留修复前失败后，[最终 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-016-r77d4eb1119fb/runs/run-7a091380-a7d6-4381-947b-2f6c5c876892/report.md)两项 Case 在受控模型和测试音调范围通过；真实模型摘要质量与真实语音效果尚未评估，Decision 为 `continue`，全项目路径状态不因此提升。

2026-10-15 的 [EXP-020 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-020/evaluation/observations.md)记录摘要专用关闭思考、有界队列和 PCM 流式播放整改，涉及 `PA-04/05/06/07/08/10`。机器合同、协议截获、真实模型与实际播报分别记录；18 次真实 DeepSeek 比较均未在期限内收到正文，当前环境的真实 TTS 连接失败，本地 Qwen 按用户要求未连接，不能据此声明真实响应时间或听感目标达成。全项目路径状态不因此提升。

2026-10-12 的 [EXP-017 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-r94f3b07e080f/evaluation/observations.md)补充 `PA-05/06/08/10` 的新实例、真实 MCP 装载、周期任务创建、原 Session 恢复和两次到期巡检回执。[正式 API Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-r94f3b07e080f/runs/run-fc23de09-a04f-4d74-8c05-b26dfe214eae/report.md)在首次到期前停止实例，失败结论保留；[追录 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-r94f3b07e080f/runs/run-3c86eb9a-b49b-435e-aad3-0610c8fab123/report.md)人工核对两次到期的目录、巡检发起和结果查询，`U-INS-005` 在此范围通过。[定向浏览器证据](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-r94f3b07e080f/evaluation/evidence/browser-path-20261012/continuation/U-INS-007/checks.json)又在当前实例核对概览、MCP 配置、新会话与同 `runId` 续查；服务结果 `PARTIAL`，不判业务通过。长期周期稳定性、其他业务和跨实例平台身份链未由此验证，全项目路径状态不因此提升。

2026-10-12 的 [EXP-017 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-rb20b8c6b906f/evaluation/observations.md)补充了 `PA-04/05/06/08` 的匿名规范读取与授权回退、真实浏览器发现、DSH 工具 Schema、分组鉴权和业务调用证据。`tee` 不在当前 Agent Guard 工具范围，上游部分接口仍返回 403；没有业务 Case Run，全项目路径状态不因此提升。

2026-10-12 的 [EXP-017-r94 OpenAPI 回归与继承整改](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-017-r94f3b07e080f/evaluation/observations.md#2026-10-12-openapi-回归与继承整改)补充 `PA-03/05/06/08` 的继承检查退出码、目标制品回归、同名实例保留 HOME 重建、实际 DSH Schema 和 Web 发现操作证据。技术回归已修复，业务授权与历史未决结论不因此改变，全项目路径状态不提升。

2026-10-12 的 [EXP-018 API 重复比较与实例观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-018-rfbf7fd53a340/evaluation/observations.md)补充 `PA-04/05/06/07/08/10`：固定 EXP-017 来源后两次 Baseline、独立 Candidate 修订与重复 Run、同标准镜像的两个隔离实例身份及只读装载、活动/空闲/停止未知/重启恢复 Session 的 API 记录。失败 Run 和评审分歧保留，巡检 `PARTIAL` 不作为完整业务通过；本次只覆盖修改后新装载，不证明来源回退。证据定位步骤减少尚未证明人工效率收益，跨实例页面、`232:18120`、当前分支全局平台 `PA-12` 与 Research Release 均未由此验收，全项目路径状态不提升。

2026-10-15 首次 Mock 接入验证覆盖 `PA-05/06/08/12`：独立实例原样装载 EXP-019，MCP 管理界面完成模拟 API/MCP 配置、回读与发现，新 Session 完成文本业务和报告下载，周期任务完成到期与清理。接口清单、原始 Session、浏览器及限制集中保存在 `mock_service` 项目的 `docs/security-operations-expert接入.md`，本仓库不复制证据。默认本地模型不可达，成功 Session 使用既有官方模型；仅隔离 HOME 禁用开发 HMR 以解决本机监听资源不足，当次业务 Harness 与原实例未改动。该结果仅证明模拟环境接入，不提升真实上游、研究效果或 Research Release 状态。

同日按用户要求将平台现有 `security-operations-expert-eval` 接入 Mock：优先在实例 MCP 插件保存连接与业务分组，仅对不读取插件配置的固定后端补充运行环境；同名、同端口、同 HOME 和标准镜像重建，Harness 资产不改动。真实 Session 完成巡检、故障查询、策略及应急确认；SOC 和报告后端另做原客户端可达检查，未在该实例重新执行完整研判。旧 `security-operations-expert-mock` 的容器和登记已删除，HOME 保留。最终分组、浏览器、后端和删除证据仍集中在上述 Mock 接入说明，平台重建需重新注入环境的边界亦在那里维护。

2026-10-19 的 [DSH rc.2 升级验收](../platform/plugin/test/evidence/dsh-rc2-upgrade-20261019/README.md)补充 `PA-05/06/08/12`：验收时两管理平台与四业务容器实际使用 `0.2.1-rc.2`，保留原端口、HOME、来源及访问方式。六实例真实模型轮次、六页管理界面、业务桌面/390px/设置/刷新/双向 WebSocket、旧含内容会话导出通过；两个基础 Mock 巡检完成报告与 CSV 下载，SOC 只读 MCP 查询通过。隔离 HOME 探针验证原生 Schedule 恢复、三角色装载与工具边界、真实前台委派及取消、旧 Session 字节保留；官方 9 个构建 gate、平台 521 项和适配器 186 项等检查通过。首轮失败、私有备份、数据仓库无本轮资产变更及限制见记录。小模型试验部署的后续处置见下方“任务工作副本清理”，原六实例验收事实保留。当次升级尚未覆盖统一业务网关、共享 Runtime 用户隔离与 MCP 风险联动；后续独立实施见下方新增验收。语音仅检查入口与只读配置路由，不提升全项目路径、Harness 效果或 Release 状态。

### 任务工作副本清理

2026-10-19 按用户要求退役六个任务工作副本：`hep-task-delivery-data`、`hep-management-assets`、`hep-data-management-assets`、`harness-data-decision-samples-20261016`、`hep-small-model-platform`、`hep-small-model-data`。已停止 3124 管理平台进程，移除 3125 的 `hep-small-model-inspection`、配套 `home-init` 容器及两份专属 fallback 卷；3121 核对时无进程。六目录已移除，五份 Git worktree 登记已清理，分支保留。

清理前的六份目录快照、未提交资产与运行状态，以及程序、数据仓库全部 refs 的 Git bundle 保存在私有备份 `/home/admin/harness-engineering-platform-backups/worktree-cleanup-20261019-154951/`。快照逐文件比较和 Git bundle 校验通过。历史 Run 与原始验收 JSON 保留其身份，旧路径、端口、PID 和六实例验收数量仅表示当时快照；本次清理不重新证明业务效果或 Research Release 可复现。

清理后六目录及关联进程、容器、专属卷和启动引用均未发现残留，3121、3124、3125 无监听。主平台 3090 与业务实例 3081、3089、3114 的 PID、容器名称、HTTP 200 和页面标题与清理前一致，未重启保留实例；主数据仓库原有 232 个变更文件的内容与权限模式保持不变。本轮仅核对运行状态与页面响应，未新增模型业务请求。

### PA-01 项目定位、AI 协作入口与项目 Memory

- **要回答**：新的 AI 开发会话能否区分平台按需求建设与业务 Harness 研究流程，读到中文优先、功能范围与交付质量分开约束、简洁优先、单一事实源、根因整改、精准修改和四项安全底线；创建分支前是否按任务名称、描述和上下文选择对象与工作流；收到 review 请求时能否定位项目审查原则并覆盖开发工具与目标智能体 Harness；Memory 是否只作为辅助上下文。
- **操作链**：读取根级 `AGENTS.md` 和 README → 按根级分支与开发工作流判断任务及新分支名称 → 进入对应平台开发或 Harness 引导技能 → review 任务按需读取 `docs/项目审查原则.md` → 解析 `.codex/config.toml` → 按任务检索经验总结与术语表 → 在受信任的新会话观察规则、技能选择和 Memory 是否生效 → 确认会话能找到本矩阵。
- **当前证据**：仓库检查可确认稳定协作入口、审查方法唯一正文、引导技能和 `features.memories = true`。2026-10-13 已人工对照平台页面、通用工具修复、业务提示词、评估文档及跨对象任务五类目标，并在临时 Git 仓库创建、核对五个对应分支名；根级规则是分类与命名的唯一维护位置，README 和技能只引用。协作入口已接入[纠错经验索引](AI纠错经验总结.md)和[分层术语表](项目术语表.md)，规则与技能保留当前有效的检查动作；原始纠错记录保持不变。
- **定位与工具链校验（2026-10-15）**：项目定位、规范解释、平台设计、术语和直接相关技能已同步为平台建设为主、研究成果持续融入；业务 Harness 研究继续使用既有研究流程。[校验器回归](../tests/test_validators.py)覆盖不再强制全仓研究口号、缺失原有核心原则仍被拒绝，以及原资产与证据合同。65 项扩展回归中，首次因 PATH 使用系统 Node 12 导致 3 项失败，改用 Node 24 重跑这 3 项后通过，其余 62 项通过；Python 使用 3.10。仓库校验无错误或警告，本次修改涉及的本地文档链接与锚点检查通过，历史研究资产、受控副本和摘要未改动；本轮未验证新独立 AI 会话或新增业务评测，不提升现有路径状态。
- **界面交付规则（2026-10-20）**：根级[功能范围与交付质量](../AGENTS.md#项目定位与工作方式)及[界面交付质量](../AGENTS.md#界面交付质量)已纳入协作规则，[平台开发 Skill](../.agents/skills/dsh-platform-development/SKILL.md)引用该节。本轮核对规则文本与本地链接，使用当前程序仓和数据根运行仓库校验器通过；未以新独立会话验证规则实际采用，也未重新验证界面行为。
- **缺口**：实际生效还受项目是否受信任、用户配置和启动参数影响，需要新会话观察；本次未验证独立新 AI 会话的自动命名与隐式技能发现，因此仍是部分验证。
- **自动化边界**：文件存在、配置类型和稳定链接进入测试；“当前会话确实使用了 Memory”保留为实机观察。

### PA-02 规范来源、受控副本与适用范围

- **要回答**：来源身份是否没有漂移，是否明确区分平台开发、Harness 研究的当前合同与后续生产化参考。
- **操作链**：读取 `SOURCES.md` → 核对受控副本 SHA-256 和锁定 Commit → 读取 `PROJECT-INTERPRETATION.md` → 来源变化时人工判断影响。
- **当前证据**：`agent-engineering-spec` 已锁定到 `aa3f27ae0b785191d0a122a6857154640073d73b`，两份受控副本的 2026-10-13 本地术语修订身份、原版摘要与 Git 恢复定位见[来源锁定](standards/SOURCES.md)，原版恢复摘要及当前摘要已核对，摘要漂移负向测试通过；锁定提交和稳定文档入口已有机器检查；任务路由、多轮引导和外部资产复用原则的当前采用方式记录在项目解释中。
- **自动化边界**：文件身份进入测试；“新来源是否适合当前任务”由人判断。

### PA-03 仓库结构、项目技能与研究资产合同

- **管理业务资产分工（2026-10-16）**：[装载与研究工具验收](../platform/plugin/test/evidence/management-assets-20261016/README.md)核对数据根业务规则与 12 项 Skill、程序研发技能和研究工具的分工；真实助手请求装载数据资产，缺失 Skill 时历史仍可读、新任务明确受阻。隔离环境证据不替代正式服务切换验证；工作副本后续处置见[任务工作副本清理](#任务工作副本清理)。
- **要回答**：研究资产是否放在正确位置，是否避免重复 Baseline/current 和定义投影，Experiment、Run 和 Research Release 是否具备最小可复现内容。
- **操作链**：由 `harness-guided-workflow` 判断创建、迁移、修改或优化任务并路由现有技能 → 只读检查外部资产 → 核对每个 Agent 只有一个 `evaluation.md` 当前业务测试源，Case 以场景归组，除名称、用户输入和预期外仅允许可选的 `fast` 标记 → 运行仓库校验 → 运行 Experiment 校验 → 用负向样例验证重复 `definition.md`、技术 Case、额外字段、未知选择、非法身份、空资产和危险链接会被拒绝。
- **当前证据**：程序研发技能与数据工作区业务技能分别检查；`runtime/research/` 中的 `inspect_source.py`、`validate_repository.py`、`validate_experiment.py` 及其测试覆盖当前确定性合同，评测合同测试覆盖场景与 `fast` 解析。2026-10-13 新增平台开发技能并登记为必需技能，两个工作流入口通过技能格式校验，仓库校验和 `RepositoryValidatorTests` 的 14 项测试通过；临时反例确认缺失新技能、缺失其元数据及调用策略类型错误均被拒绝，33 个入口与技能本地链接及相关锚点通过检查。经验与术语入口已列入仓库必需文件；6 个更新技能通过格式校验，当前仓库校验与 14 项仓库合同测试通过。两处业务 UI 的显示名称已同步源码和生成物，类型检查、构建及现有交互测试通过；未验证新实例装载。本次 390 个本地链接无新增错误，12 张术语修订图片已核对名称、布局和尺寸。这些检查不证明 AI 工具已实际选择新技能。
- **自动化边界**：结构、格式、引用和摘要进入测试；研究内容是否真实、有价值不由校验器打分。

### PA-04 Experiment 来源解析、被测身份与材料隔离

- **要回答**：选择的 Experiment 是否解析到正确 Agent、Preset 和资产；被测角色与评分角色是否只看见各自需要的材料。
- **操作链**：解析 `experiment:<id>` → 分别生成 `subject`、`scoring` 计划 → 核对评测实例的 `session_preset` 与 `target_preset` → 评分角色只读挂载 `/work/reference` → 反向确认被测角色没有参考答案和判断材料。
- **当前证据**：来源合同、挂载计划和角色隔离测试覆盖当前机器合同；全部已登记 Experiment 解析到同一份 `source.lock.json` 和同一个镜像构建指纹，来源覆盖版本字段会被拒绝，Candidate 不再持有 DSH 版本锁；[EXP-009 实机记录](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/evidence/dsh-dev-lifecycle-20260929.json)确认被测实例选择的来源、Preset 和只读挂载，且没有挂入评分参考目录；[`dsh-plugin-restart-20260922.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-test01-002/runs/run-a4abf894-4750-4113-8497-7fc08a3a36b5/evidence/T-AUTHORING-PLUGIN-PERSISTENCE/dsh-plugin-restart-20260922.json) 仅作为退役 `authoring` 与当时 `verification` 边界的历史实机记录。
- **自动化边界**：路径、字段和挂载计划进入测试；实际 DSH 加载属于 `PA-06`。

### PA-05 `dsh-dev` 实例完整生命周期

- **统一网关业务模式（2026-10-19）**：[实施验收](platform-design/21_统一网关与MCP控制实施验收.md)记录新增 `--business-control`、独立 HOME／bridge、回环端口、标准镜像和固定来源；原研究实例保持原方式。首期关闭定时服务与后台投递，范围不扩展到历史任务。
- **业务实例访问入口（2026-10-20）**：`dsh-dev url` 与平台实例管理共用业务网关入口合同。内部 53107 端口仅供 Runtime，浏览器打开登记的 53105 公开地址；错误主机、端口、Agent 路径及未登记实例由测试拒绝，实机点击结果见[浏览器记录](../platform/plugin/test/evidence/instance-gateway-web-20261020.json)。

- **任务试验实例退役（2026-10-19）**：关联隔离实例、容器与运行状态的处置见[任务工作副本清理](#任务工作副本清理)。
- **要回答**：本地实例能否从参数预览到停止完整运行，失败时是否如实报告。
- **操作链**：`up --dry-run` → `up` → `ps` → `url` → `logs` → `up --replace` → `down` → `delete`（保留 HOME）；同时检查缺参数时的可用值列表、自动实例名与端口、端口竞态、缺少环境变量、单一 stdout JSON 和停止失败。
- **当前证据**：单元测试覆盖当前 eval-only CLI 合同、新建 Experiment 时只引用全仓 DSH 锁而不生成 Candidate 锁，以及旧实例的只读运维兼容；既有实机证据见 [`dsh-dev-identity-and-lifecycle-20260919.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-dev-identity-and-lifecycle-20260919.json)、[`dsh-review-followup-20260920.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-review-followup-20260920.json) 和 [`dsh-plugin-restart-20260922.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-test01-002/runs/run-a4abf894-4750-4113-8497-7fc08a3a36b5/evidence/T-AUTHORING-PLUGIN-PERSISTENCE/dsh-plugin-restart-20260922.json)，但这些实机记录早于本次模式收敛。
- **当前试点证据与缺口**：[EXP-009 生命周期记录](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/evidence/dsh-dev-lifecycle-20260929.json)在同一来源上完成 `up --dry-run`、`up`、`ps`、认证 `url` 探针、`logs`、`up --replace` 和 `down`，确认容器重建、HOME 保留及停止后无运行容器；缺少必填环境变量的替换请求在重启前被拒绝。尚未实测端口竞态或停止失败等其他异常分支。Docker 自动删除曾短暂卡在 `removing`，见 [`dsh-global-lock-image-20260928T104351Z.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/evaluation/evidence/dsh-global-lock-image-20260928T104351Z.json)，后续装载和 Run 已恢复。
- **首阶段工具证据（2026-10-13）**：`dsh-dev` 的 96 项测试通过，包含删除失败时保留登记、HOME 查询失败拒绝完成及实际参数校验。平台实例模块复用该入口，先预览后执行，同名操作串行，批量逐项返回回执。[双实例 Docker 记录](../platform/plugin/test/evidence/stage1-docker-20261013.json)证明两实例共用同一 Image ID、HOME 与端口独立、Harness 挂载只读；停止并删除一台后另一台仍运行，两个 HOME 卷均保留。测试容器与登记已清理，未操作用户实例。该探针使用 `--allow-missing-env`，不证明模型或业务 Session 成功。
- **交互与性能整改证据（2026-10-13）**：[生命周期浏览器记录](../platform/plugin/test/evidence/stage1-remediation-lifecycle-20261013.json)仅操作独立测试容器，覆盖启动、停止、重启、删除取消与 stopped 删除，确认保留 HOME，随后清理测试登记。[171 实例只读查询记录](../platform/plugin/test/evidence/stage1-remediation-performance-20261013.json)三次耗时为 415、417、411 ms，状态均为 7 running、164 stopped；用户既有实例未操作。
- **容器状态与批量删除根因整改（2026-10-13）**：此前无容器的登记被归为 stopped，最新 [135 条登记检查](../platform/plugin/test/evidence/stage1-instances-state-20261013.json)区分 5 running 与 130 absent，查询耗时 412 ms；默认列表只展示有容器的实例，无容器登记可单独筛选并清理。删除由 CLI 按目标核验，不再逐项扫描全部登记。[165 个真实 Docker 容器检查](../platform/plugin/test/evidence/stage1-instances-bulk-165-20261013.json)以独立 Alpine 夹具验证五项一批、逐项进度、全部删除成功及 HOME 保留，运行容器被拒绝删除；结束后仅清理测试资产，用户登记保持不变。该批量夹具不证明业务 DSH 装载。
- **统一实例访问实机证据（2026-10-13）**：[标准 DSH 容器检查](../platform/plugin/test/evidence/stage1-instance-web-policy-20261013.json)验证 CLI 与平台新建时无需访问开关即可监听局域网、匿名访问并跳过内测声明；旧停止登记启动及平台重启应用相同规则，端口与 HOME 卷保留，两个实例共用标准 Runtime 镜像。评测 API 执行器可通过免认证入口注册工作区；旧 Token 入口的兼容由机器合同覆盖。规则唯一维护于[实例访问规则](../runtime/adapters/dsh-container/README.md#实例访问规则)。探针显式允许缺少业务环境变量，平台重启请求也仅对测试实例加入此标记；未执行业务 Case，未重启用户既有实例，测试容器、登记与专用卷已清理。
- **自动化边界**：参数、状态转换和失败报告进入测试；Docker 进程、认证交接和真实停止状态用实机探针。

- **Web 子路径访问（2026-10-15）**：[EXP-019 容器检查](../platform/plugin/test/evidence/web-base-assistant-20261015.json)核对标准镜像与只读 Web 适配器，`dsh-dev url` 返回 `/assistant/`；根页面与缺少尾斜杠入口保留查询参数跳转，旧根 API/MCP/语音入口不再命中。真实浏览器覆盖资源、动态插件、RPC、Session 创建与恢复、导出、MCP 管理公开路径，以及语音 Worker、WASM/data 和 Worklet 装载。一次冷启动技术请求超时未能唯一定位，保留原观察后复跑通过。首次装载暴露语音插件把实际运行包列为开发依赖；修正声明后，[独立生产依赖安装检查](../platform/plugin/test/evidence/web-base-assistant-dependencies-20261015.json)在不使用临时链接、不改变锁内版本的情况下完成完整 Profile 启动与语音资源访问。仅验证 URL 与装载行为，未调用模型或外部业务服务；测试实例停止并删除登记，HOME 保留。
- **Web 子路径模型请求补充（2026-10-15）**：用户实例发送问候时暴露 Web 适配器包缺少 `version`，锁定 Runtime 的 DeepSeek 插件身份清单因此在发出请求前失败。补齐包元数据后，[原失败会话复测](../platform/plugin/test/evidence/web-base-assistant-deepseek-20261015.json)在同一容器、原 DeepSeek 模型及 `/assistant/` 页面再次发送“你好啊”，约 2.2 秒完成并显示回复；原失败轮次保留，未重启或更换模型。共享适配器类型检查、8 项单测及调用真实锁定 Runtime provider 的正反向集成测试通过。此次补充证明消息调用链恢复，不替代业务 Case Evaluation。

### PA-06 被测容器的真实装载与只读边界

- **受控业务装载（2026-10-19）**：[统一网关验收](platform-design/21_统一网关与MCP控制实施验收.md)在独立数据快照装载固定 EXP-021，核对标准镜像、只读程序／资产／策略、真实 HMAC 通道及来源回执；未修改 Candidate 或重建派生镜像。不证明任意插件或子 Agent 全链已受控。

- **要回答**：评测容器是否加载正确来源，并形成三棵 Candidate 资产只读、判分材料不可见的视图。
- **操作链**：确认镜像身份 → 启动评测实例 → 核对目标 Preset、Skill、Plugin/MCP 声明、三棵只读挂载和判分材料不可见性。
- **当前证据**：Compose、来源计划和装载探针测试覆盖当前机器合同；全仓版本锁对应的新镜像已核对 Image ID 与构建指纹，全部九个已登记来源的隔离 `verify-load` 均通过，见[装载证据](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/evaluation/evidence/dsh-global-lock-load-20260928T112027Z.json)。EXP-007 的真实 Web 会话曾完成自动化任务创建、查看和删除，见其 [Decision](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/decision.md)。语音隔离实例使用同一锁定来源的标准镜像，已核对四个 Candidate/依赖挂载均为只读，见[构建证据](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/evaluation/evidence/dsh-image-build-20260929T102953Z-875853.json)及[语音 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-fe58afad-133d-44fb-b92c-19bf74523083/report.md)。
- **当前试点证据与缺口**：[EXP-009 生命周期记录](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/evidence/dsh-dev-lifecycle-20260929.json)核对了容器内 Prompt 与宿主 Candidate 的摘要一致、三棵资产只读以及评分材料不可见；[Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/observations.md)关联实际 API Session 和原始回答。九个来源的 `verify-load` 仍只证明配置组合；OAuth、定时触发和其他业务语义未因此获得验证。
- **自动化边界**：Compose 和计划合同进入测试；真实容器内可见内容用容器探针。

### PA-07 宿主修改、装载观察与回退闭环

- **要回答**：修改是否真正进入受 Git 管理的 Candidate，并在新会话中产生可观察变化。
- **操作链**：记录基线引用或资产摘要 → 宿主开发会话修改 Candidate → 复核 Git diff 与摘要 → 新评测容器、新 Session 观察 → 回退 → 再建会话确认旧行为消失。
- **当前证据**：[`dsh-dev-real-session-20260919.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-dev-real-session-20260919.json) 记录一次已退役容器开发模式下的 Skill 闭环；[`dsh-plugin-restart-20260922.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-test01-002/runs/run-a4abf894-4750-4113-8497-7fc08a3a36b5/evidence/T-AUTHORING-PLUGIN-PERSISTENCE/dsh-plugin-restart-20260922.json) 记录当时的插件命令和 HOME 持久化观察。当前 `mutation-receipt.py` 提供摘要、冻结、校验与缺席目标恢复。
- **当前试点证据与缺口**：[EXP-009 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/observations.md)记录了 Prompt 修改、两次修订候选的新容器与 Session 观察，以及重新选择 EXP-008 来源后的资产摘要和回答；语义效果限定在所选问法。新 Preset、Plugin 变化和真实业务 MCP 的修改与回退仍未覆盖。
- **自动化边界**：摘要、冻结与恢复合同进入测试；模型行为和真实工具效果由 Experiment Run 记录。

### PA-08 DSH Runtime API 与 Web UI 的 Session、消息与结果闭环

- **即时任务检测、防护（2026-10-19）**：[统一网关证据](../platform/plugin/test/evidence/business-control-20261019/README.md)关联真实双用户 Session、模型巡检调用、自动风险收紧／恢复及报告归属下载。A 写操作受限时目标零新增，B 与 A 只读继续；解除后新操作恢复且不重放。外部身份、风险和设备结果来自 Mock，定时任务与业务子 Agent 全链未由此验证。

- **要回答**：受管评测能否分别通过 DSH Runtime API 完成业务 Turn，并通过 Web UI 完成用户可见链路冒烟，两者不混算结果。
- **操作链**：启动 Web → 使用本次认证 URL → API 默认路径注册 Workspace、逐 Case 创建正确 Preset 的 Session、发送消息、等待 Turn 并导出轨迹；或显式选择浏览器路径，核对页面进入、新会话身份、发送和回答显示。
- **当前证据**：[`dsh-web-technical-preflight-20260915T054223Z.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-web-technical-preflight-20260915T054223Z.json) 记录技术预检。`dsh-eval` 已实现默认 API 与显式浏览器执行器；两者共享 Case、精确 Preset/Workspace 身份检查和证据格式，分别形成 Run。评审 Preset 放在评测适配层，与被测 Candidate 分离。命令结果用 `executor` 标明通道，运行态 Case 证据用 `transport` 标明通道。替身进程测试覆盖 `fast/full/--case` 选择、通道选择、每 Case 新 Session、多轮同 Session、启动、认证入口、结果封存、停止和 Token 不落盘；插件实验另记录了宿主重启后的 Profile 持久化。[`run-8941fbbc-8f7b-42f0-9890-d2f12249e79b`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-8941fbbc-8f7b-42f0-9890-d2f12249e79b/report.md) 是本实现产生的真实 DSH Runtime API `full` Run：40 个 Case 全部完成，原始 Session、工具事件和逐 Case 评审证据均已封存，受管实例已停止。
- **当前新镜像证据**：[`run-2028f3b1-7a8c-42ea-9da6-2a59f5187262`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-2028f3b1-7a8c-42ea-9da6-2a59f5187262/report.md) 以全仓锁构建的新镜像完成 `U-QA-003` 的真实 API Turn 和独立评审 Turn；评审请求的工具列表为空，机器判定 1/1 通过，受管实例已停止。
- **当前工具切片证据**：[EXP-009 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/observations.md)关联两次修订 Candidate 的 `U-QA-012/013` 真实 API Run、对应基线及来源回退 Run；分别保留被测 Session、评审证据、实际模型路由和原始回答。机器两题通过，人工结论限定为所选问法下方法说明更完整。
- **语音浏览器证据**：同一标准镜像的隔离实例已封存 [`Qwen 浏览器 Run`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-fe58afad-133d-44fb-b92c-19bf74523083/report.md)，真实麦克风、远程 ASR、语音发送、模型回复和 TTS 解码链路通过；[`默认 DeepSeek 浏览器 Run`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-e6a57ade-9cfe-4a47-9637-85e07ee423fe/report.md) 因外部 MCP 工具 schema 悬空引用失败。
- **巡检浏览器补充证据**：[EXP-015-r632 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/evaluation/observations.md)关联同一实例的 `U-INS-002/007` 页面试跑和连续导航，确认可见回答、一次发起及同 `runId` 续查；两个新 HOME 的正式浏览器 [Run 1](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/runs/run-1aa3c04c-8a53-482a-951a-16f06f12f827/report.md)、[Run 2](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/runs/run-1d3814b5-b1b1-4812-90a0-74f464ac8218/report.md)完成 `U-INS-002` UI 冒烟，核对目标会话与回答显示，业务结论均为 `inconclusive`；[新增失败 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/runs/run-0631c1d6-4d37-40b3-bb13-9dffd754490c/report.md)在连接工作区时超时，未执行 Case。此前[另一新实例 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-015-r6328dfd1ae6e/runs/run-d3a1e3d5-dddc-42a6-9543-e02a3e129924/report.md)在执行 Case 前失败，原因尚未定位。
- **缺口**：[EXP-007 门户联调](https://github.com/wr5912/harness-engineering-platform-data/blob/12b6f552d4c15a475d9443c7029276810aafdbf4/agents/security-operations-expert/docs/门户联调记录.md)历史试点曾在 iframe 中完成真实 Web 会话；当前免认证直连实例的浏览器工作台、模型回复、自动化任务入口及独立启用 `--skip-testing-notice` 后“内测声明”刷新不再弹出已验证，但门户代理切换后的 iframe 尚未重测。语音 Run 使用真实浏览器脚本与 `run_record.py` 封存，其他业务 Case 的浏览器链路及默认模型的语音回复仍待验证；现有 Run 不证明全部 MCP 业务语义，也不代表生产验收。
- **自动化边界**：确定性的通道编排与异常闭环进入测试；身份、工具目录和证据由执行器生成，仍需从真实 API Run 或浏览器冒烟 Run 核对；模型与 MCP 语义仍需人工判读。

### PA-09 新 Preset 创建、登记、重载与选择闭环

- **要回答**：新 Preset 是否由宿主开发会话写入 Candidate、登记来源，并被新容器、新 Session 实际选择。
- **操作链**：通过引导技能创建 Experiment Candidate → 复核差异与 Preset ID → 登记 `sources.json` → 启动新评测实例 → 在 Web 或 Runtime API 中选择 → 观察结果。
- **当前证据**：`dsh-dev init`、Preset 身份映射和来源一致性已有机器检查。
- **缺口**：还没有按当前宿主创建路径完成真实登记、装载、选择和观察的完整记录。
- **自动化边界**：身份和路径一致性进入测试；Web 选择及运行行为属于 E2E。

### PA-10 Research Run 的创建、记录、缺口与封存

- **变体来源与现有 Run 定位（2026-10-16）**：同页来源入口读取已有 Experiment 声明，实际核对 `024 → 023 → 021` 的父版与固定 Git 引用；`EXP-security-operations-expert-002` 的缺失父版显示“父版本未记录”。浏览器确认 024 诊断 Run 入口及既有比较恢复，生成源码与数据根中的 TypeScript 逐字节一致。此次只改善既有来源、源码与 Run 的浏览定位，没有新增模型评测、Run 或业务效果结论；真实研究范围继续以 [LangGraph 代码变体验收](platform-design/18_LangGraph代码变体验收.md)为准。

- **代码变体的外部输入冻结与基准诊断（2026-10-16）**：原始样本封存回归 8/8、共同基准真实 DSH 四 Case 诊断 4/4，失败 Run 同时保留；输入身份、原始证据和按角色用量见 [LangGraph 代码变体验收](platform-design/18_LangGraph代码变体验收.md)。外部响应是明确标注的 Mock 重放及受控覆盖，不表示真实 SOC 事实；第二阶段两侧重复评分已保留，但变体工作流输出被 DSH 拒绝并回退原子调用，不能作为代码变体装载或资源收益证据；第三阶段在干净程序和同一固定输入下各两次 Run，父版8/8与变体8/8，八项图均实际成功，机器比较满足预定质量和资源指标；该结果只限本轮四 Case。存储合同见 [03](platform-design/03_存储架构与数据契约.md#当前代码变体与固定外部输入)。

- **迁移后研究闭环（2026-10-16）**：[真实评测与产物验收](../platform/plugin/test/evidence/management-assets-20261016/README.md)完成固定来源派生、假设与观察编辑、同用例双侧评测、Decision 双摘要保存回读及合同校验。首轮回执适配失败保留，修复后两个新 Run 均为 2/2 通过且完成证据复核；报告与 ZIP 实际下载通过。业务数据为基础 Mock，结论保持 `inconclusive`，不证明改进收益；关联 `PA-04/06/07/08`。
- **要回答**：一次运行能否说明“用的哪版、输入是什么、观察到什么、有哪些失败和限制”。
- **操作链**：`init` → 逐项 `record` → 必要时 `gap` → `finalize` → 反向确认封存后不能追加结果；受管路径由 `dsh-eval` 完成同一闭环。
- **当前证据**：Run v2 将 `execution_status` 与 `verdict` 分离，要求材料化 `evidence_ref`，并在 `completed` 封存前覆盖全部锁定 Case。`run_record.py` 与 `dsh-eval` 的机器测试覆盖 `fast/full/--case` 选择、所选 Case 的完整输入和预期快照、完整场景目录、API/浏览器通道分离、证据、异常封存、场景分析摘要、报告中去重 Case 的覆盖与归因假设、封存后拒绝追加；`full` 归因测试还覆盖当前 Run 的只读挂载、一场景一 Session、受限只读工具和必读证据访问校验。插件实验另保留一次实际初始化、记录、缺口和封存回执。真实 [`full` Run 报告](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-8941fbbc-8f7b-42f0-9890-d2f12249e79b/report.md) 已封存 40/40 个 Case：机器判定为 32 通过、8 失败；[`analysis.json`](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-8941fbbc-8f7b-42f0-9890-d2f12249e79b/analysis.json) 记录 4 个独立场景 Session 对 40/40 个 Case 的完整复核，形成 24 条带支持 Case、反例 Case、原始证据引用、替代解释和证伪方法的缺口假设，报告正文同步呈现。
- **当前新镜像证据**：全仓锁对应的 [`U-QA-003` Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-2028f3b1-7a8c-42ea-9da6-2a59f5187262/report.md) 已封存完整输入、来源、目标与评审轨迹，机器判定 1/1 通过。[EXP-009 Evaluation 观察](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-009/evaluation/observations.md)关联同一标准镜像下的新旧来源多次封存 Run、人工复核及 Decision；`run_record.py index/show/compare` 在两个真实查证任务中把多处证据定位收敛为查询入口，查找步骤减少，未测人工阅读时间。
- **语音 Run 证据**：`U-VOICE-001` 的 [Qwen 通过 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-fe58afad-133d-44fb-b92c-19bf74523083/report.md)和[默认 DeepSeek 失败 Run](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-007/runs/run-e6a57ade-9cfe-4a47-9637-85e07ee423fe/report.md)均已记录实际浏览器观察、来源、输入和限制并封存。
- **跨条件对照工具证据**：2026-10-07 的 Run 生命周期测试以两个不同预期模型封存共同 Case，确认新报告包含来源、冻结口径、Trial、观察、证据和模型差异；旧报告不改写。`compare` 将有共同结果标为可观察对照，将模型差异标为因果归因限制。此为机器合同验证，尚无本次中文优先和本地 Qwen 组合的新实机 Run。
- **缺口**：已有真实 API Run、模型请求、MCP 调用和场景归因路径；仍需由研究者独立审阅归因质量，并用后续重复 Run 检验可复现性。语音浏览器 Run 仅覆盖单 Case 的两种模型路径，默认模型失败；现有记录不构成 OAuth 或生产验收。
- **首阶段工具合同（2026-10-13）**：平台复用 `dsh-eval` 与 `run_record.py` 提供 Case 预览、评测进程启动/状态/取消、Run 索引/报告/Case/比较及已有轨迹查询。合同测试覆盖子进程状态与脱敏、固定父提交派生、编辑摘要冲突及创建失败恢复。旧 Run 未冻结 Case 定义时保留原始选择，合同是否变化显示为未知，不用今天的定义补写历史事实。轨迹按已有材料查询，只显示脱敏后的前 64 KiB，截断明确提示；本轮未新增模型评测 Run，不会用子进程退出或浏览器工具测试推定研究假设成立。
- **自动化边界**：schema、唯一 ID、状态转换、证据引用和封存进入测试；观察是否支持假设由人审阅。

- **用例冻结与完整轨迹（2026-10-15）**：Run 初始化从单次解析冻结用例、场景目录和摘要，执行器只消费冻结快照；当前用例保存不使活动 Run 失效。新增冻结竞态回归 2 项、真实驱动协议测试 8 项通过，覆盖主/子会话、评审与归因、repair、超时及失败时的轨迹归属。实际最小身份 [Run 报告](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-test01-002/runs/run-35fc537e-774b-42e9-b016-6b3999962f67/report.md)的被测 Case 与逐项机器评审为 1/1 通过；AI 场景归因因 `analysis-tools-invalid` 失败，整体保留 `inconclusive`，实例已停止。该 Run 保存了被测、评审及失败归因的原始轨迹，[采集核对](../platform/plugin/test/evidence/evaluation-real-run-20261015.json)记录 20 个文件和凭据检查；不据此确认业务 Harness 的改进效果。

### PA-11 Research Release 打包、解析与复现装载

- **要回答**：一个值得保留的研究版本能否按清单恢复并重新装载。
- **操作链**：从完成的 Experiment 选择版本 → 生成自包含 Release → 核对逐文件摘要 → `release:<id>` 解析 → 只读装载 → 核对实际身份和至少一个声明行为。
- **完成标准**：同一 Release 能从自身清单恢复；复现报告同时写明成功、失败和已知限制。
- **当前证据与缺口**：静态目录合同将由仓库校验器覆盖，但当前没有 Research Release，`dsh-dev` 也未实现 `release:<id>`，因此完整路径未实现。
- **自动化边界**：清单、摘要和解析进入测试；真实 DSH 重新装载用复现探针。该结论不包含生产部署验收。

### PA-12 全局 DSH 平台启动、认证与研究工具

- **Web 数据加载链路优化（2026-10-21）**：[当前仓实机与截图](../platform/plugin/test/evidence/web-load-20261021/README.md)核对 `mcp/list` 的组合绑定不再重复运行 Git：6 个已发布组合、6 个版本和总览由 52 条同步命令降至每次列表 4 条异步命令，Git 来源与实现摘要字段保持原合同，固定版本执行复用预检结果。插件类型检查、构建与使用 Python 3.10 的全量 Node 测试通过。正式 3090 重建并装载本仓，Profile 用户 Patch、MCP 配置和本地凭据摘要不变；真实登录后 5 次 `mcp/list`、`home` 中位分别为 532、1052 ms，稳态并发 CSS 早于 `home` 返回。首页和 MCP 页桌面／390px 实际内容、布局及读取通过，未修改前端源码。重启后首次打开仍需 17.1 秒完成数据加载，动态 `/hep/plugins/` 脚本 TTFB 达 6.5–9.3 秒；本项只证明数据链路改善，不声称整个首开等待已解决，也未验证业务实例固定绑定或模型效果，`PA-12` 状态不提升。

- **UI 产品化逐页验收（2026-10-20 至 21）**：在 `feat/PLATFORM-ui-productization` 分支按指定 HTML 原型调整首页、智能体、评测、实例、网关和 MCP 页面；原生“管理对话”界面保持不变。[逐页记录](../platform/plugin/test/evidence/ui-productization-20261020/README.md)包含 3091 隔离服务的桌面/手机截图、断点与暗色主题、Chrome 实际 200% 缩放、助手避让、首页草稿恢复、Run 路由和本地 MCP 连接回执。最终六页桌面/手机逐页检查 38/38（各页内容读取完成后截图）、统一网关四视图 46/46、实例创建与停止预览 16/16 通过；智能体版本在 1440/390px 切换真实两版，选中状态与地址一致。GUI 创建 `023` 来源业务实例 7/7，原生新 Session 9/9、页面回看 3/3；原生管理对话经一次确认也创建 `023` 来源测试实例；该实例后经[GUI 启停回执复验](../platform/plugin/test/evidence/ui-productization-20261020/final/mimo-receipt-browser-e2e.json)18/18 项通过，最终停止并保留 HOME。3090 未由本任务操作。运行中 Job、网关业务调用、双会话冲突及完整业务覆盖仍缺证据，`PA-12` 一级状态保持“部分验证”。

- **算力变体策划与共享模型设置（2026-10-21）**：[3091 逐页记录](../platform/plugin/test/evidence/ui-productization-20261020/README.md#生成与比较模型设置)包含“生成与比较”对指定原型的首次 153 项及后续 103 项浏览器检查、390px 布局 18 项和补充字段 5 项复验。低算力请求从真实 Run 单次交给平台助手，MiMo-V2.6-Flash/high 原生回合完成，17 次工具调用均为只读；回复说明近似等效待验证，本轮没有创建变体、训练或比较 Run。原生“设置 → 模型”共享 DSH 模型目录：平台默认 MiMo-V2.6-Flash/high，业务智能体统一默认 MiMo-V2.6-Flash/off，单个实例可另选。模型草稿 13/13、当前设置回读 5/5、平台新 Session 8/8 和业务实例新 Session 9/9 通过；模型设置与 Session 回执证明配置、路由和一次回复；隔离 `023` 来源另经预检明确选择 `U-INS-003`，[真实 Run](../platform/plugin/test/evidence/ui-productization-20261020/final/mimo-eval-real-summary.json) 的目标与 Judge 均使用 MiMo/off，单 Case 1/1 通过、来源相符，评测实例已停止；[评测中心桌面和手机回读](../platform/plugin/test/evidence/ui-productization-20261020/final/mimo-eval-gui-readback.json)11/11 项通过，能按 Run ID 精确定位并区分执行状态与业务结论。完整 AI review 未请求。网关[实机预检](../platform/plugin/test/evidence/ui-productization-20261020/final/mimo-gateway-e2e-audit.json)表明 3091 网关关闭且 31893 未受信登记，未发送端到端业务请求。插件全量 775/775、dsh-dev/dsh-eval 153/153、平台启动器 34/34 和最终构建通过；提交前 3091 六页桌面和手机复验 42/42，当前隔离数据根无实例登记。3090 未由本任务操作，`PA-12` 一级状态不提升。

- **统一网关管理界面四视图（2026-10-20）**：[3090 实机记录](../platform/plugin/test/evidence/gateway-overhaul-20261020/README.md)确认运行概览独立、身份／风险／访问配置共用草稿与统一保存，接入用户基础许可说明与运行限制多选交互可用；未访问页面延后挂载后，身份页只读 HTTP 探测在真实页面返回 `405` 并明确未验证 POST 合同。390px 页面无横向溢出，跨页草稿及放弃恢复通过，配置摘要未变；插件全量测试 595/595、构建通过。本轮没有提交人工限制或新业务任务，真实提供方和生产环境未验收，`PA-12` 一级状态不提升。

- **统一网关工作区位置与名称（2026-10-20）**：[3090 实机记录](../platform/plugin/test/evidence/gateway-unified-tabs-20261020/README.md)确认智能体身份、风险评估和访问控制三页签统一为上方功能配置、下方共用的“运行状态与操作”；运行区包含实例回执、风险限制、执行记录与相关操作。真实登录后在 1920／1440／1250／1024／768／390px 检查三个配置面板的左边界与宽度一致，运行面板均位于其下且无横向溢出；访问控制内部的宽屏双栏和手机顺序排列仍有效，跨页签草稿及放弃恢复通过。29 项相关测试、类型检查、构建、仓库校验通过，页面错误及失败请求为零，业务配置摘要不变；身份页的智能体目录加载及真实业务效果未纳入本轮验收。

- **访问控制布局优化（2026-10-20）**：[3090 实机记录](../platform/plugin/test/evidence/gateway-access-layout-20261020/README.md)确认 Agent 范围与操作允许清单在 1920px／1440px 并列、390px 顺序排列，操作字段有独立标签且目标地址使用整行，动作选择按需展开并在手机端显示已选数量。29 项控制管理与导航测试、类型检查、构建和仓库校验通过；真实登录后的刷新、分类切换、添加与移除草稿、放弃恢复均通过，无页面错误或横向溢出。业务访问配置摘要不变；本轮未保存真实策略或执行受保护业务。

- **访问控制选择项（2026-10-20）**：[3090 界面记录](../platform/plugin/test/evidence/gateway-access-selectors-20261020/README.md)确认服务从当前操作允许清单勾选，动作与操作方法使用受支持选项；“不限定服务”与“限定后零选择”的原有授权含义保持区分。23 项控制管理测试、类型检查及构建通过；3090 登录后的桌面／390px 页面、刷新保留草稿和放弃恢复通过，业务访问配置摘要不变。本轮没有保存真实业务配置或执行操作，实际效果仍以运行许可和受保护请求为准。

- **统一网关选择器与紧凑状态栏（2026-10-20）**：[实机记录](../platform/plugin/test/evidence/gateway-selector-ui-20261020/README.md)确认智能体选择器复用资产列表，支持名称／ID 搜索、只读关联 ID、版本与业务实例核对；未知身份和失败读取保留已有配置，更换对象清除旧来源及启用状态。页内大标题移除，桌面状态区从约 122px 缩至约 21px，390px 下约 46px且无横向溢出。50 项针对性测试、类型检查、构建及 3090 真实登录、草稿保留、放弃恢复、刷新和深色主题通过；首次重载窗口连接失败及最终复验均保留。原 Profile、HOME 和业务配置保持一致，没有执行业务任务或提升定时闭环结论；最新进程定位见记录。
- **统一网关分类整改 3090 生效（2026-10-20）**：按用户后续要求构建并重载原 3090 平台，原 Profile、数据根、HOME 和账号保持一致；[实机证据](../platform/plugin/test/evidence/gateway-classification-20261020/README.md#3090-实际生效验证)确认三类配置入口、MCP 第五个重复按钮消失且顶部网关入口可用。真实登录、刷新深链、草稿保留及放弃恢复、深色主题和 1440px／390px 布局通过，无页面错误或失败请求；没有保存业务配置、调用模型或操作业务实例。运行页面仍显示真实未配置状态，不提升真实业务或定时任务检测、防护闭环结论。
- **统一网关分类整改源码验证（2026-10-20）**：[计划](platform-design/20_业务访问与运行控制插件开发规范.md#分类整改顺序与完成条件2026-10-20)与[隔离验证记录](../platform/plugin/test/evidence/gateway-classification-20261020/README.md)覆盖“智能体身份、风险评估、访问控制”三类入口，身份内保留凭据与可信来源分区；移除 MCP 页签栏重复的统一网关按钮，顶部一级入口保留。类型检查和 63 项针对性测试通过，1440px／390px 测试数据预览验证布局与草稿保留。该阶段只修改源码并临时构建验证，没有更新共享运行制品、重启平台或验证 3090 实际装载；不提升真实业务、Harness 效果或 Release 状态。下条四项界面记录保留当时事实。
- **统一网关一级界面（2026-10-19）**：[3090 实机与验收](platform-design/21_统一网关与MCP控制实施验收.md)记录一级 `#/gateway`、平台一致主题、状态概览、四功能切换与桌面双栏工作台；真实空配置、刷新、深链、轮询和跨页草稿保留经过浏览器检查。认证／信任对象为业务 Agent，接入用户另列；实际状态以签名、风险及回执为依据，保存不等于生效。

- **任务试验平台退役（2026-10-19）**：隔离平台与工作副本的处置见[任务工作副本清理](#任务工作副本清理)，已合入的工具与弱推理适配功能继续由主程序和数据仓库维护。
- **管理助手工具合同与弱推理验收（2026-10-17）**：[原始错误流验证](../platform/plugin/test/evidence/extraction-json-20261017/README.md)之后，模型侧改为逐操作参数合同和单题抽样传输，固定目标内特性与样本预览自动保存回读；两次原生 JSON 恢复有界且不重放工具。[实机验收与截图](../platform/plugin/test/evidence/assistant-flash-off-20261017/README.md)分别记录隔离 Flash/off、正式页面按钮及候选语义复核。只读巡检完成固定三 Case、独立实例与五设备报告下载，预算和重启恢复另测；生成与编译不代替装载或等效，候选保存不代替人员复核或训练质量。此项关联 `PA-03/04/08`；本地小参数模型不可达，Mock 通过不提升真实上游验收结论。

- **独立变体名称与名称搜索（2026-10-16）**：变体名称使用独立的 `change.yaml.variant_name`，列表、详情及版本选择器读取同一名称，缺失显示“未命名变体”；现有搜索支持名称及子串，策略和研究问题保留原用途。实际通过 UI 将隔离数据中的 024 命名为“资产关联告警查询（LangGraph）”并保留，[首次浏览器记录](../platform/plugin/test/evidence/variant-name-20261016/attempt01-acceptance.json)发现版本选项未读取精简 DTO 之外的名称，修复后[命名验收](../platform/plugin/test/evidence/variant-name-20261016/acceptance.json)9/9 通过，覆盖详情/list 回读、名称搜索、刷新、改名控件、创建名称必填及已有比较恢复，页面错误与失败请求均为零。[元数据保护核对](../platform/plugin/test/evidence/variant-name-20261016/metadata-preservation.json)确认仅名称字段改变，研究问题、策略及 Candidate、Run、Decision、比较回执共 2130 个文件或链接的摘要不变；没有新增 Experiment、Run 或模型调用，也未改正式数据与既有归档。名称实现全量回归 428/428 通过，随后修复版本选择器和列表迟到响应再次构建并通过相关测试 30/30。[桌面](../platform/plugin/test/evidence/variant-name-20261016/name-1440.png)、[390px 列表](../platform/plugin/test/evidence/variant-name-20261016/name-390.png)与[390px 详情](../platform/plugin/test/evidence/variant-name-20261016/name-390-detail.png)保留实际名称布局；原阶段 13 项浏览器证据继续保留。当前 [3115 验收入口](http://10.0.160.32:3115/hep/#/agents?agent_id=security-operations-expert&experiment_id=EXP-security-operations-expert-024-r290c02339cb3&tab=overview&list_view=variants)进程为 `3778448`，日志为 `/tmp/hep-variant-name-20261016/platform-final.log`，停止命令为 `kill -TERM 3778448`；[装载来源与 11 个文件摘要](/tmp/hep-variant-name-20261016/environment.json)一致，正式 3090 仍为原进程。存储与页面合同分别见 [03](platform-design/03_存储架构与数据契约.md#当前代码变体与固定外部输入)和 [06](platform-design/06_界面与前后端渐进建设.md#35-当前第一阶段页面)。

- **智能体与变体同页浏览（2026-10-16）**：左侧“智能体列表、变体列表”共用右侧详情，变体列表保留搜索，按用户最新要求移除三项下拉筛选；智能体变体数量入口显示所属范围并可“查看全部”。来源卡默认收起，桌面首屏可见详情标签，原 `tab=compute-variants` 链接继续定位“生成与比较”；独立 `list_view` 随刷新及前进后退恢复。插件全量回归 418/418 通过；随后移除下拉控件再次构建并通过相关客户端、导航和来源测试 27/27。[隔离浏览器证据](../platform/plugin/test/evidence/variant-overview-20261016/acceptance.json)13 项交互通过，覆盖草稿与所选对象保留、搜索及所属范围、真实父版追溯、源码回读、历史来源未知和 1440/900/390px 布局，页面错误与失败请求均为零；[桌面截图](../platform/plugin/test/evidence/variant-overview-20261016/desktop-collapsed.png)、[900px 截图](../platform/plugin/test/evidence/variant-overview-20261016/layout-900.png)与[窄屏截图](../platform/plugin/test/evidence/variant-overview-20261016/layout-390.png)保留实际布局；切换左侧标签未新增详情、代码变体上下文或 Run 请求。隔离数据当前只有一个算力变体，跨 Agent 选择及迟到响应由客户端回归覆盖；不据此新增业务效果结论。实际入口为 [变体列表与 024 概览](http://10.0.160.32:3115/hep/#/agents?agent_id=security-operations-expert&experiment_id=EXP-security-operations-expert-024-r290c02339cb3&tab=overview&list_view=variants)，[装载来源与五个源码摘要](/tmp/hep-variant-overview-20261016/environment.json)相符；该阶段 3115 进程为 `3717252`（后续命名验收已重启），日志为 `/tmp/hep-variant-overview-20261016/platform-final.log`，停止命令为 `kill -TERM 3717252`。该阶段未改动正式 3090 或业务资产，既有 LangGraph 归档保持原样；没有调用模型、创建或改写 Run、提交或推送。

- **LangGraph 代码变体程序接入（2026-10-16）**：固定父版与诊断轨迹计划、TypeScript 写入、构建、差异预览及独立冻结确认、进度与源码读取已接入既有任务和评测；完整插件测试 405/405、API 诊断回归 9/9 通过；无远程开始证据的空 attempt 保持未知，真实失败与重试保留，正式四 Run 指标不变。真实管理助手已生成并冻结 024；第一阶段因 Guard 局部片段覆盖装载失败，取消后保留 89 次已观测消耗。第二阶段两侧运行已完成，但变体输出违反 lossless JSON 合同，业务通过包含原子回退，取消后保留 97 次消耗；第三阶段在干净快照取得真实成功图回执与两侧各两次 Run，机器比较达标；目标模型请求22→16（减少27.27%）、总token203606→126279（减少37.98%），局部耗时与输出仍有回退，管理任务已实际交付（80次=26管理+54评测），只读界面验证任务卡、源码和刷新恢复比较；未捕获待确认卡。程序、只读界面、真实失败及当前边界见 [LangGraph 代码变体验收](platform-design/18_LangGraph代码变体验收.md)。结论仅限固定 Mock 四 Case，不构成总体统计等效或真实 SOC 收益，也未确认 `end`；当前流程与接口合同继续只在 [06](platform-design/06_界面与前后端渐进建设.md#36-不同算力需求的近似等效变体)、[04](platform-design/04_核心业务闭环与服务接口.md)和 [03](platform-design/03_存储架构与数据契约.md#当前代码变体与固定外部输入)维护。

- **数据根管理助手（2026-10-16）**：[隔离环境验收与截图](../platform/plugin/test/evidence/management-assets-20261016/README.md)记录五类只读模型任务、旧会话续用且原事件不变、缺失 Skill 提示，以及研究工具闭环与报告下载。程序仓库仅保留精简摘要和截图，完整研究证据位于仓库外；正式部署验证另附。
- **统一工作台与实机截图（2026-10-16）**：[验收与截图](../platform/plugin/test/evidence/ui-workbench-20261016/README.md)记录六页五宽度 30 项、首页/编排/报告 15 项、原生设置、动效和深色/触屏验证。首页通用对话经实际模型只读查询通过；编排侧栏统一显示状态，移除样例创建按钮。隔离环境完成实例创建与停止、MCP 保存回读与真实查询、固定巡检 Case 两次 1/1 通过及报告下载；真实外部数据仅为基础 Mock。平台完整 350 项、最终入口调整后 5 项、解释器链 21 项回归及构建通过。手机报告表格、MCP 对象参数与子进程 Python 选择已修复，首次失败及刷新观察保留；并发业务扩展源码尚未配套，正式服务沿用此前固定构建产物，具体部署边界见记录。此项关联 `PA-08/10` 工具链，不提升真实安全业务或 Research Release 结论。

- **要回答**：研究者能否通过系统全局 DSH 装载平台插件，经平台密码登录使用首页、管理对话、智能体管理、评测中心、实例管理和 MCP 管理，并保持已有资产与 Run 的事实源连续。
- **操作链**：`platform/dsh-platform prepare` → `start --dry-run` → `start` → 平台密码登录 → 六页真实操作 → 停止 → 重启并核对来源与会话 → 退出并拒绝旧 Cookie；入口与合同见[平台设计方案](platform-design/02_系统架构与部署设计.md#当前最小平台接入合同)。分工与完成标准见[四目录计划](platform-design/09_首轮实施Backlog与工作切片.md#6-已选第一阶段四目录并行计划)。
- **任务交付正式复验（2026-10-16）**：[正式入口记录](platform-design/17_任务型智能体交付与验收.md#正式入口复验)核对现有平台上的单次实例启动、来源拒绝及精确权限恢复、同实例新 Session 的实际业务和下载，以及首页“改进优化任务”的需求入口和可选运行关联。[正式页面证据](../platform/plugin/test/evidence/task-delivery-20261016/formal-homepage-and-pages.json)覆盖三模式与六页共 27 组布局观察；没有借此重跑构建任务、修改固定 Case 或提升真实业务上游验收结论。
- **浏览器标签品牌（2026-10-16）**：登录、初始化与正式页面复用同一 `harness-logo.svg`，正式 HTML 移除原生明暗图标候选并设置平台标题。当前全局 DSH 的原生布局没有标题配置入口；平台 Web 适配器在既有客户端制品转换中替换产品名，沿用原生 Session 标题投影，移除平台客户端的一次性标题写入。正式 3090 改由本工作树装载，保留同一数据根与平台 HOME，用户 Patch 逐字节一致。[本机浏览器记录](/tmp/hep-favicon-20261016/after.json)覆盖 20 个状态：登录、六页、明暗主题、刷新、深链和隔离初始化页，均为唯一可解码的共享 SVG，标题包含“Harness工程平台”且没有原生产品名；三个服务端首帧标题亦通过，页面错误与图标 404 均为零。构建、适配器类型检查及 8 项测试、原生认证与 5 项初始化回归通过。此前仅图标通过时仍为原生标题的记录及登录 CSP 阻止验收脚本直接 fetch 的初次失败均保留在同一临时证据目录；验证改用独立浏览器页读取图标，未放宽登录策略。本项仅验证平台品牌与装载。
- **管理页内容宽度（2026-10-16）**：评测中心移除独立的 1600px 最大宽度，左右留白与实例管理、MCP 管理统一。正式 `/hep/` 在 1920、1440、900、390px 下三页内容左右边界一致，无整页横向溢出；真实读取 109 条运行记录和所选 Run 详情，评测三标签及 MCP 四标签切换正常，浏览器无页面错误或失败 API。类型检查、构建及评测客户端 21 项回归通过。本轮复用原有进程生效，没有重启平台、调用模型、修改业务资产或执行实例生命周期操作。本机测量、截图与检查记录位于 `/tmp/hep-page-width-20261016/`。
- **程序仓库更名（2026-10-16）**：现有 GitHub 仓库更名为 `wr5912/harness-engineering-platform`，本地 origin 已更新；仓库 ID、默认分支及可见性未变，更名前后的 3 个分支与 5 个 Tag 引用完全一致。当前名称、仓库链接、克隆说明及开发技能引用已同步；本地程序目录、插件包名、标准镜像、数据工作区和历史记录保留。仓库合同校验零错误、零警告，变更文档的 195 个本地链接均存在。正式 `/hep/` 的浏览器登录、六页切换、工作区和实例及组合目录读取通过，无页面错误或失败 API；两个原有业务容器继续运行。本轮未重启服务、调用模型或执行实例生命周期操作。首次探针错误假定实例总数为 2，实际登记为 8，改为核对原有实例存在后通过；未修改实例状态。本机核对记录位于 `/tmp/hep-repository-rename-20261016/`。此项关联 `PA-01`、`PA-03` 的名称一致性，不改变业务 Evaluation 或 Research Release 结论。
- **实例界面与导航（2026-10-16）**：[当前页面设计](platform-design/06_界面与前后端渐进建设.md#35-当前第一阶段页面)已在正式 `/hep/` 验证：六页仅保留顶部导航，390px 窄屏可切换；实例创建预览后取消、筛选外选择提示与取消、详情页签键盘切换、真实嵌入地址生成及复制、刷新保留与切换清理通过。平台回归 276 项及相关交互 10 项复验通过，构建通过；浏览器无页面错误或失败 API，未执行实例生命周期写入。本机记录为 `/tmp/hep-instance-detail-ui-20261016/acceptance.json` 及同目录截图。仅证明本轮界面与交互，不提升业务能力结论。
- **历史证据（2026-10-12）**：本分支当时的启动器 10 项测试、插件 8 项测试、TypeScript 构建及仓库合同校验通过。查询识别 2 个 Agent、20 个 Experiment、61 个 Run。来源提交 `5c0f50a` 记录的全局 DSH 和浏览器证据来自其他仓库状态，不能替代当前分支的实机验收。
- **当前机器合同（2026-10-13）**：四个功能分支已在 `feat/platform-stage1-foundation` 集成；本轮插件 51 项、启动器 13 项、容器适配层 94 项测试通过；评测访问合同另通过 2 项 Python 测试及 1 项 API 执行器测试（覆盖五种认证响应），评测通道共用合同 6 项检查通过，仓库合同校验无错误或警告。插件覆盖实际 Cordis 注册、RPC 分派与取消、首页真实 Run 排序、智能体版本/编辑/失败恢复、旧 Run 限制与轨迹脱敏、实例生命周期与批量回执、MCP Session Header/有限 SSE/错误回执/只读组合。密码认证检查覆盖原生 API、三个写入域及 MCP 网关、旧 Token/Cookie 拒绝、Host/Origin 限制、会话持久化与过期、退出撤销、账号变更失效，以及配置损坏与卸载后保持拒绝访问。业务容器的免认证访问与平台密码登录分别验证。
- **受控浏览器证据（2026-10-13）**：[14 项检查记录](../platform/plugin/test/evidence/stage1-browser-20261013.json)使用实际客户端构建产物和原生 Cordis WebServer/Connection，验证首页与标识、固定父提交派生、编辑预览与写入、旧 Run 和已有轨迹、实例预览失效、OpenAPI 调用及发布工具的两步执行；延迟响应不会覆盖新的智能体、文件或正文选择。页面载体与认证记录存储是受控夹具，未使用全局 DSH 壳。[桌面首页](../platform/plugin/test/evidence/stage1-home-desktop-20261013.png)及 375px 深色模式的[首页](../platform/plugin/test/evidence/stage1-home-mobile-20261013.png)、[智能体](../platform/plugin/test/evidence/stage1-agents-mobile-20261013.png)、[实例](../platform/plugin/test/evidence/stage1-instances-mobile-20261013.png)、[MCP](../platform/plugin/test/evidence/stage1-mcp-mobile-20261013.png)均保存；四页没有横向溢出或客户端页面错误。写入仅在临时资产克隆内发生，结束后清理。
- **密码登录改动前的全局 DSH 历史证据（2026-10-13）**：Node `v24.21.0`、系统全局 DSH `0.2.1-alpha.2` 下，[11 项原生浏览器检查](../platform/plugin/test/evidence/stage1-global-dsh-20261013.json)通过，包含[真实首页](../platform/plugin/test/evidence/stage1-global-home-20261013.png)、已有轨迹、实例创建预览、MCP Gateway 生命周期、端口释放与重启恢复。当时未配置模型时，“稍后配置”在重启后再次提示；该行为已由本轮平台 Profile 和客户端插槽调整。保留[Node 切换中断记录](../platform/plugin/test/evidence/stage1-global-node22-interrupted-20261013.json)及[先前检查失败记录](../platform/plugin/test/evidence/stage1-global-failed-1791883367014.json)，不改写历史观察。
- **当前密码登录实机证据（2026-10-13）**：相同 Node 与全局 DSH 版本下，[18 项独立 HOME 浏览器检查](../platform/plugin/test/evidence/stage1-platform-login-global-20261013.json)通过，包含匿名入口与接口拒绝、错误密码、登录与 Cookie 属性、桌面与 375px 移动端四页、已有轨迹、实例预览、MCP Gateway 生命周期、重启保持会话、退出后拒绝旧 Cookie，以及账号或插件加载失败时退出并释放端口。首次使用与重启均无预览版说明或模型欢迎弹窗；[手动模型配置入口](../platform/plugin/test/evidence/stage1-login-model-settings-20261013.png)仍可编辑，未保存模型或凭据。保存[桌面登录](../platform/plugin/test/evidence/stage1-login-desktop-20261013.png)、[移动端登录](../platform/plugin/test/evidence/stage1-login-mobile-20261013.png)及[首页](../platform/plugin/test/evidence/stage1-login-home-20261013.png)。[最初登录失败记录](../platform/plugin/test/evidence/stage1-platform-login-failed-1791886963154.json)保留；根因是登录页的 `no-referrer` 令浏览器表单 Origin 变成 `null`，改为 `same-origin` 后实机通过，仍拒绝外部与 `null` Origin。
- **全新 HOME 首次使用证据（2026-10-13）**：[7 项首次登录检查](../platform/plugin/test/evidence/stage1-platform-first-login-20261013.json)另建 HOME，启动前确认无 Session、偏好或凭据存储；首次登录即可打开平台并读取已有 Run，无预览版说明、模型欢迎弹窗或客户端错误，结束后释放测试端口。此记录补充首次使用条件，不以已使用 HOME 的重启检查替代。
- **页面整改实机证据（2026-10-13）**：[全局 DSH 页面检查](../platform/plugin/test/evidence/stage1-remediation-browser-20261013.json)核对参考图蓝白首页、离开首页后的平台导航、Run 与轨迹查询、实例列表和操作窗口。[MCP 检查](../platform/plugin/test/evidence/stage1-remediation-mcp-20261013.json)核对复用原生插件的服务/分组配置、工具调试和固定组合发布，受控接口完成实际协议调用。[管理对话检查](../platform/plugin/test/evidence/stage1-remediation-conversations-20261013.json)核对重复标题及品牌隐藏、默认收起侧栏、单列表、新 Session 的项目仓库工作区与标准模式、草稿保留、原生搜索与设置，以及桌面、900px、390px 无横向溢出。测试未发送模型请求，未操作用户既有容器。
- **管理对话模型实机证据（2026-10-13）**：通过原生模型页面保存 DeepSeek 和本地 Qwen 提供商。[DeepSeek 问候检查](../platform/plugin/test/evidence/stage1-remediation-chat-20261013.json)在项目仓库、标准模式实际发送“你好”，约 5 秒得到可见回复；重启后的[本地 Qwen 问候检查](../platform/plugin/test/evidence/stage1-remediation-chat-local-20261013.json)使用服务实际提供的 `Qwen3.8-27B`，约 9 秒得到可见回复。两次均无客户端错误。[配置保留检查](../platform/plugin/test/evidence/stage1-remediation-model-settings-20261013.json)核对凭据引用和 `0600` 权限，并确认再次 `prepare` 与重启保留凭据和模型设置；证据不包含密钥或服务私有地址。问候成功只证明管理对话调用链，不替代业务 Harness Evaluation。
- **首页与智能体布局复核（2026-10-13）**：[首页对话入口检查](../platform/plugin/test/evidence/stage1-home-entry-20261013.json)确认居中布局、1260px 内容和 640px 单行入口，发送后进入原生管理对话并得到可见回复，900px 与 390px 无横向溢出。[智能体检查](../platform/plugin/test/evidence/stage1-agents-tabs-final-20261013.json)确认默认选择最新版本，同时区分运行中的活动版本；基本信息、资产、编辑、评测与 Run 用标签切换，窄选择栏、草稿保留、键盘操作和四种屏宽均通过。实例表头另验证筛选后的全选与半选。
- **MCP 页面专项复核（2026-10-13）**：[审查与整改记录](../platform/plugin/test/evidence/stage1-mcp-layout-review-20261013.md)逐项说明宽度、统计区、工具栏重复、草稿和长内容的整改。[16 个布局组合检查](../platform/plugin/test/evidence/stage1-mcp-layout-final-20261013.json)验证四标签在 1920、1440、900、390px 的布局；原生保存按钮移至页头，标签改为“编排工具”，保留原生校验和编辑草稿。客户端错误与设置写入均为零；调试接口为受控边界，未据此验收外部业务 MCP。
- **批量操作失败恢复（2026-10-13）**：[受控网络中断检查](../platform/plugin/test/evidence/stage1-instances-bulk-transport-20261013.json)在 12 项操作中保留 8 成功、1 失败、1 结果未知和 2 未派发的区别，发生中断后不自动重试；手动刷新可继续核对实际状态。真实容器批量检查见 `PA-05`，两类证据不互相替代。
- **实例访问入口复核（2026-10-13）**：`PA-05` 的统一访问检查同时覆盖真实表格入口：新标签页使用平台的局域网主机地址及实例登记端口，URL 不含 Token，原页面留在实例管理，新浏览器上下文没有内测声明弹窗；访问失败时关闭等待标签并显示错误，停止后禁用入口。平台客户端错误为零。局域网地址仅由宿主机浏览器访问，未用另一台设备验证网络连通性。
- **业务实例入口复核（2026-10-20）**：[3090 浏览器记录](../platform/plugin/test/evidence/instance-gateway-web-20261020.json)覆盖列表和详情入口、未登录个人表单、Mock 用户登录后真实 DSH Web、原页面保留及零页面错误。页面标明内部端口和业务网关，避免将回环 Runtime 端口误写成用户访问端口；未验证其他设备连通性。
- **资产与轻量组合机器合同（2026-10-13）**：`fix/PLATFORM-agent-assets-mcp-ui` 的插件 55 项、启动器 13 项、来源合同 20 项及评测访问合同 2 项测试通过，TypeScript 检查与构建通过，仓库合同校验无错误或警告。资产编辑在临时工作树执行真实 `dsh-eval --dry-run`，预览不写入，直接保存也必须 dry 校验；覆盖无效 YAML/来源拒绝、缺少环境变量提示、`!!js` 不执行、并发摘要冲突和旧 Run 不改写。LangGraph.js 两节点组合复用现有只读 OpenAPI 调用，覆盖实际两次 HTTP 请求与结果映射、失败停止和取消回执；组合 dry 校验参数、图和依赖登记，不请求上游接口或执行节点。[编排 Skill](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/mcp-composition/SKILL.md)引用唯一 SDK 实现，由平台 Profile 显式启用宿主技能目录装载。
- **资产与轻量组合实机证据（2026-10-13）**：[13 项浏览器检查记录](../platform/plugin/test/evidence/stage1-assets-langgraph-20261013.json)使用独立 HOME、系统全局 DSH `0.2.1-alpha.2`、Node `v24.21.0` 和实际构建客户端，验证友好基本信息、三个标签、[真实资产树及详情](../platform/plugin/test/evidence/stage1-assets-tree-20261013.png)、编辑弹窗、dry 失败保留草稿、预览不写入、保存再次 dry 校验、[冲突拒绝覆盖](../platform/plugin/test/evidence/stage1-assets-conflict-20261013.png)、评测与 Decision 编辑入口、[编译图展示](../platform/plugin/test/evidence/stage1-langgraph-composition-20261013.png)、[390px 组合布局](../platform/plugin/test/evidence/stage1-langgraph-mobile-20261013.png)及原生新 Session 发现 `mcp-composition` Skill；客户端错误为零。实例详情嵌入说明生成并复制与访问入口同一 RPC 结果的 iframe URL。写入只发生在临时测试资产，实例数据为受控只读夹具；未调用模型、外部业务工具或用户既有实例，也未验证另一设备及跨站 iframe 的实际访问。
- **当前平台重启生效（2026-10-13）**：重新构建、更新既有 Profile 并重启局域网 3090 平台；[实际地址浏览器记录](../platform/plugin/test/evidence/stage1-assets-3090-20261013.json)和[编排页面](../platform/plugin/test/evidence/stage1-assets-3090-20261013.png)确认原账号登录、友好概览、三个标签、真实资产树、编辑弹窗、真实资产 dry 预览不写入、编译图与新 Session 的编排 Skill；客户端错误为零，登录与模型设置文件摘要保持一致。当前平台无实例且未登记示例上游，未创建实例、修改连接、执行业务工具或验证跨站嵌入。
- **编排目录与版本机器合同（2026-10-13）**：插件测试增至 59 项并全部通过；草稿和发布配置只在 `platform/mcp-compositions.json` 维护，测试使用独立夹具，不依赖用户可编辑目录。覆盖保存后重载、多编排与连接选择、旧发布版在编辑期间继续调用、草稿不进入 Gateway 发现、发布前必须再次 dry、名称冲突、无效配置、损坏目录及并发变更拒绝覆盖。dry 和发布校验的上游请求均为零；发布后 Gateway 只切换所选工具，其他发布版保持可用。
- **编排侧边栏与重启证据（2026-10-13）**：[浏览器检查记录](../platform/plugin/test/evidence/stage1-compositions-sidebar-20261013.json)在已重启的 3090 平台确认三组列表、留在 MCP 页面、编译图和真实 `soc-api` 草稿的 dry 结果；[当前页面](../platform/plugin/test/evidence/stage1-compositions-3090-20261013.png)可从局域网地址查看。保存、发布、并发冲突和重载使用临时目录及受控连接验证，未改动用户的编排、连接或登录配置。[桌面布局](../platform/plugin/test/evidence/stage1-compositions-sidebar-20261013.png)与[390px 布局](../platform/plugin/test/evidence/stage1-compositions-mobile-20261013.png)对应 1440、900、390px 无横向溢出，客户端错误为零。[首次浏览器失败](../platform/plugin/test/evidence/stage1-compositions-browser-failed-20261013.json)保留精确标签选择器超时，改用文本框角色选择器后重跑通过。
- **真实 soc-api 接口缺口（2026-10-13）**：[只读规范检查](../platform/plugin/test/evidence/stage1-compositions-soc-api-20261013.json)确认其 OpenAPI 有 106 条路径、129 个操作；资产列表与详情分别为 `list_soc_asset`、`get_soc_asset_by_asset_id`，没有现有 SDK 所需的 `get_asset`、`list_alerts`，也未发现告警操作。用户已保存连接为 `soc-api` 的草稿，现有发布版保留；真实资产关联告警适配尚未完成，需要告警接口定义。dry 仅证明输入、图和连接登记，不证明上游工具或参数映射可用；未请求登录或业务接口，未发布用户工具。
- **已发布编排接入分组合同（2026-10-14）**：插件 60 项测试全部通过，TypeScript 检查、构建和仓库合同校验通过。[实际原生插件协议检查](../platform/plugin/test/evidence/stage1-composition-service-protocol-20261014.json)确认派生的 `platform-compositions` 服务经原生分组 MCP 完成初始化、发现及两步实际调用，受控上游收到两次请求；缺少 Bearer 和未选择工具均拒绝。草稿不对外提供，发布 dry 不请求上游，发布后发现立即切换；更名后须在分组重新选择。服务投影不写入原生配置，调用回执脱敏；此证据未验证真实 SOC 告警或模型选用工具。
- **服务列表与重启实机证据（2026-10-14）**：重新构建并重启既有 3090 平台，[浏览器检查记录](../platform/plugin/test/evidence/stage1-composition-service-browser-20261014.json)确认“服务列表”页签、描述与启用状态、密码显隐、[已发布组合服务](../platform/plugin/test/evidence/stage1-composition-service-3090-20261014.png)、原生调试发现及[分组选择](../platform/plugin/test/evidence/stage1-composition-service-group-20261014.png)。发布使用临时目录，页面立即同步新工具并保留未保存的原生服务与分组草稿；截获的保存请求仅包含原生服务配置和分组引用，不持久化派生服务。1440、900、[390px 布局](../platform/plugin/test/evidence/stage1-composition-service-mobile-20261014.png)无横向溢出，客户端错误为零。用户服务、编排和账号文件不变，凭据仅更新预期登录会话；未验证另一设备或真实 SOC 业务调用。
- **服务保存与草稿刷新复核（2026-10-14）**：插件 62 项测试、TypeScript 检查和构建通过。[客户端回归](../platform/plugin/test/mcp-client.test.mjs)覆盖派生组合服务不参与保存、错误服务及字段定位、外层页签同步，以及同内容配置重新读取保留草稿、内容变化继续同步。已在真实页面成功保存 `biz-soc-framework` 并刷新回读描述 `18080` 与原凭据；[重启后浏览器记录](../platform/plugin/test/evidence/stage1-mcp-service-save-20261014.json)与[服务页面](../platform/plugin/test/evidence/stage1-mcp-service-save-20261014.png)验证保存请求只包含原生服务、失败自动选中出错项并返回服务列表，客户端错误为零。回归草稿使用截获请求，不写入配置；检查期间新增的其他服务保持原样，账号与编排文件未变，凭据存储仅更新登录会话。原报告的通用错误在新加载页面未复现，未据此确认其触发原因，也未验证真实 SOC 业务调用。
- **真实 SOC 资产关联告警调试（2026-10-14）**：插件 63 项测试、TypeScript 检查、构建和仓库合同校验通过；受控接口覆盖独立适配器与原生适配器的双服务调用、对象查询参数展开、严格资产 ID、业务失败停止及 dry 零请求。已重启 3090 平台，[浏览器检查记录](../platform/plugin/test/evidence/stage1-compositions-asset-9106-20261014.json)与[实际结果页面](../platform/plugin/test/evidence/stage1-compositions-asset-9106-20261014.png)确认资产 `9106`（联试硬件服务器241，`172.16.138.241`）通过 `biz-soc-master` 的 `get_soc_asset_by_asset_id` 查询，再通过 `biz-soc-detect` 的 `list_detect_alert` 查询近 30 天关联告警：共 22 个分组、777 条告警，当前展示首页 5 个分组。两次真实 GET 均为 HTTP `200` 且业务 `code=200`，回执保留实际规范、参数模型和源码摘要。新编排保存为草稿，刷新回读及版本切换展示各自编译图，原发布版保持不变；原生服务设置、账号及非会话凭据不变，客户端错误为零。未发布新编排，未验证其他资产、全量告警明细或模型选用工具，远端服务未修改。
- **业务与功能边界**：MCP 保留“资产→关联告警”两节点只读组合，新增能力及边界见[威胁分析阶段组合](platform-design/02_系统架构与部署设计.md#threat-stage-composition)。发布版本保存工具配置，父组合固定子版本；共享 SDK 代码变更仍需构建、重新装载和受影响验证。此前真实 SOC 仅验证资产 `9106` 的近 30 天首页告警分组，不表示其他资产、全量明细或新威胁流程已经验收。平台评测与业务组合运行分别记录，不将组合产物当作 Experiment Evaluation 或 Research Release。
- **Mock 组合编排接入（2026-10-15）**：通过当前 3090 平台 MCP 管理界面新增 `mock-soc-readonly`，将“资产相关告警只读查询”的两个节点改接该连接，保存、实际执行、发布并刷新回读。页面资产 `9106` 与发布 MCP 调用资产 `9107` 均完成资产 GET → 告警 GET，返回各自基本告警分组；未知资产 404 时第二步跳过。Mock 新增两条实际路由派生的专用只读规范，保留原 19 个 SOC POST；114 项 Mock 测试和现有 native SOC 组合回归通过。平台 SDK、业务 Harness 和平台进程未改动；编排当前配置在 `platform/mcp-compositions.json`，接入说明、浏览器及协议证据集中在 `mock_service/docs/security-operations-expert接入.md`，不复制证据。本次仅证明模拟上游组合接入，没有新增模型 Run 或真实告警结论。
- **威胁分析阶段组合（2026-10-15）**：已实现[当前合同](platform-design/02_系统架构与部署设计.md#threat-stage-composition)及[操作入口](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/mcp-composition/SKILL.md)，支持四阶段子组合、固定发布版本的父组合、原生 SOC OpenAPI/报告 MCP 连接、Run 上下文与产物读取。首次联合工作树 143 项测试通过；提交前合入最新 `main` 后，插件 169 项测试、类型检查、构建和仓库合同校验通过；[阶段回归](https://github.com/wr5912/harness-engineering-platform-data/blob/12b6f552d4c15a475d9443c7029276810aafdbf4/extensions/security-operations/tests/threat-runtime.test.mjs)覆盖状态、单次模型、重放、回写、预算与源码完整性；[原 CLI 对照](https://github.com/wr5912/harness-engineering-platform-data/blob/12b6f552d4c15a475d9443c7029276810aafdbf4/extensions/security-operations/tests/threat-equivalence.test.mjs)在隔离 Python 进程和受控连接上比较基本名单快判、完整五源及可解析校验失败分支，核对冻结输入、模型请求、SOC 写回和报告内容。[实机记录](../platform/plugin/test/evidence/threat-composition-live-20261015.md)确认现有 3090 平台通过界面配置、发布五个工具及固定子版本，快速与完整路径均完成 Mock SOC 回写、报告保存及实际下载；完整路径只调用一次 `deepseek-flash/off`，但原机械校验失败，页面明确要求人工复核。原生分组实际发现五个工具并成功重放，旧资产查询回归通过；最终重启后上下文和 HTML 文本产物可读。取消与长超时通过[真实协议回归](../platform/plugin/test/native-composition-cancel.test.mjs)验证，使用当前 DSH 相同的 auto 协商；旧版无状态协议跨请求取消有限制。此范围不证明真实 SOC、完整威胁场景质量或自动调度行为，不构成 Experiment Evaluation 或 Research Release。
- **运行模型默认值（2026-10-15）**：平台和 `security-operations-expert-eval` 的新 Session 均未手动选模，实际请求记录为 `deepseek-official/deepseek-flash/off`，最小模型问候完成。Agent 统一运行覆盖在 Candidate 之后加载，平台使用原生默认值与受控凭据，模型凭据仅保存在本地忽略文件或受控服务；既有 MCP 及 Mock 后端配置保留。启动器相关检查和当前适配器 99 项测试通过；配置来源、新 Session、并发实例变更及 SDK 核对边界均在 Mock 接入说明的模型默认值章节维护。业务 Harness 文件、镜像及历史研究结果未由本次改动重写。
- **平台助手、实时更新与版本流程（2026-10-15）**：管理助手复用原生 Session、投影与工具，写操作等待确认并保留失败回执；页面通过认证事件流接收领域与稳定 ID 后重读事实源，配置刷新保留未保存草稿并核对保存版本。版本特性与融合方案保存在 `change.yaml`，融合预览核对 Git HEAD 和 Candidate 摘要，缺少真实装载及能力验证时不能完成版本；Run 新增完整 Candidate 摘要，历史记录继续可读。平台 72 项、研究工具 65 项、适配器 133 项和启动器 14 项测试及类型检查、构建通过，相关检查集中在[平台测试](../platform/plugin/test/)与[研究工具测试](../tests/test_validators.py)。当前 3090 浏览器复查确认已发布 Mock 组合仍可查询资产 `9106`，页面错误为零。本次没有重启平台或新增真实融合 Run，新增助手及融合的模型业务行为仍需单独验证。
- **自动化边界**：参数、路径、摘要、失败恢复、状态分派和平台密码认证进入测试；局域网地址监听已在本机浏览器验证，未从另一台局域网设备访问。真实 Docker 生命周期、浏览器操作、全局 DSH 装载及模型/外部业务调用分别保留证据，不互相替代。

- **双站点基址与实际平台生效（2026-10-15）**：基址唯一配置在 当时的 [`sites.json`](https://github.com/wr5912/harness-engineering-platform/blob/9afc8fd0047367deb9df5b51595f101835359044/runtime/adapters/dsh-web/sites.json)，共用 TypeScript WebServer 适配器通过原生注册接口挂载，未引入反向代理或修改系统全局 DSH。共享适配器 8 项、平台插件 64 项、平台启动器 14 项、容器 CLI/评测访问 101 项及来源合同 20 项测试通过；MCP 受控协议测试覆盖分组和 Agent 内部 loopback 的新基址。项目合同校验无错误或警告。[隔离平台浏览器检查](../platform/plugin/test/evidence/web-base-platform-20261015.json)完成登录、退出、四页、真实 RPC、双向 WebSocket 和窄屏布局；[实际 3090 平台检查](../platform/plugin/test/evidence/web-base-platform-live-20261015.json)确认 `/hap/` 已重启生效，原 HOME、账号、编排及用户配置保持原样，旧协议入口不可用。现有平台没有已保存的 MCP 分组，链接仅用未保存草稿验证；未发送模型消息、调用真实 SOC 服务或验证另一设备连通性。业务容器的观察及限制见 `PA-05`，不提升其他研究结论或 Release 状态。

- **AI 助手与版本融合机器合同（2026-10-15）**：`feat/PLATFORM-ai-assistant` 基于 `c6af2a4` 实施。插件 84 项测试、启动器 14 项、来源合同 20 项及 RunRecord/DshEval/ResearchEval 40 项相关 Python 测试通过，TypeScript 检查、构建和仓库合同校验通过。新增助手领域工具共用 GUI 业务实例，提案确认与回执保存于原生 Session；新版本确认来源、特性、冲突及所选 Case 口径后建立 Candidate，只有完整资产摘要、固定来源及真实封存 Run 验证匹配才完成。继承盘点读取固定提交中的关系，未完成、过时证据及后来修改的来源不抑制并行能力；`end` 仅在明确确认及固定来源、等效和资源证据引用齐全时排除。旧 Run 可读，但缺少新完整 Candidate 摘要的记录不充当新融合完成证明。Python 首轮暴露测试夹具复制活动分析缓存的竞争，排除该忽略缓存后定向复跑通过；既有记录未改写。
- **AI 助手原生实机（2026-10-15）**：系统全局 DSH `0.2.1-alpha.2`、Node `v24.19.0`、本工作树构建及独立 HOME 下，[8 项浏览器检查](../platform/plugin/test/evidence/assistant-20261015-ui.json)验证首页无悬浮按钮、其他页入口、项目会话、单一原生编辑器、草稿保留、刷新恢复及 390/900/1440px 布局；[桌面](../platform/plugin/test/evidence/assistant-20261015-desktop.png)和[窄屏](../platform/plugin/test/evidence/assistant-20261015-mobile.png)保存实际画面。[真实工具与模型边界检查](../platform/plugin/test/evidence/assistant-tools-20261015.json)仅替换外部模型接口，原生 Agent 实际发现并调用三类平台工具，保存提案，经[可见卡片确认](../platform/plugin/test/evidence/assistant-20261015-card.json)修改临时 Profile 的非秘密描述，回读配置及持久回执；运行状态与标准 Session 的融合、研究技能目录均核实。[并发草稿检查](../platform/plugin/test/evidence/platform-realtime-drafts-20261015.json)使用真实 React 页面及受控 RPC/Settings 边界，覆盖草稿、过时响应、对象删除和进行中回执。保留[首次接入失败](../platform/plugin/test/evidence/assistant-20261015-ui-failures.json)：修正原生会话创建互斥参数、GET Fetch 请求体合同和未就绪引用后重跑通过。实际文件监听额度不足时降级一秒状态观察；未改宿主限制。此项隔离验证期间未切换原有 3090 平台、用户实例和业务资产；随后部署见下条。未运行真实业务融合或真实模型效果比较，不提升 Experiment 或 Research Release 状态。


- **3090 生效与原生会话机制（2026-10-15）**：本次实现已定向部署到原平台运行目录，保持原资产根、HOME、账号、既有会话和最新 `EXP-security-operations-expert-020`。插件 90 项测试、启动器 17 项及容器适配器 100 项测试通过，类型检查、构建和仓库合同校验通过。[原生界面 10 项检查](../platform/plugin/test/evidence/assistant-native-20261015.json)覆盖工作区、会话菜单、搜索、分组、折叠、归档临时会话和跨工作区隔离；连续 12 轮浮窗与整页切换保留同 Session 和草稿，编辑器峰值为 1。[实际 3090 检查](../platform/plugin/test/evidence/assistant-3090-final-20261015.json)从首页真实发送“你好”，核对用户消息仅原文、内部上下文默认隐藏、原生控件、独立助手图标、版本入口及实时通道，页面异常为零。[原生确认续接](../platform/plugin/test/evidence/assistant-context-native-20261015.json)仅替换外部模型 HTTP 接口，证明同一打开的 turn 在确认前等待原工具、确认后返回真实工具结果并自然继续；日志只有一条真实用户输入，重复确认不重复业务写入。会话投影与系统提示的当前合同及冷恢复限制见 [03](platform-design/03_存储架构与数据契约.md#当前助手与版本数据)。总回归首轮使用了 shell 默认 Python 3.8，且认证夹具未提供新增原生服务；切换实际运行使用的 Python 3.10 并补齐夹具后 90 项全部通过。保留[首轮浏览器记录](../platform/plugin/test/evidence/assistant-3090-final-first-20261015.json)与[第二轮记录](../platform/plugin/test/evidence/assistant-3090-final-second-20261015.json)：分别未等待首页就绪、未对齐原生“新建会话”标签，修正探针后通过。没有修改业务 Candidate 或历史 Run，没有运行真实业务融合。
- **平台与业务实例默认模型（2026-10-15）**：[实际配置与调用证据](../platform/plugin/test/evidence/model-defaults-20261015.json)确认 3090 平台及现有业务实例的新会话均使用 `deepseek-official/deepseek-flash`、推理强度 `off`，真实调用完成。平台启动器从本地忽略的 `models.llm-api-key` 注入模型变量；业务实例复用同一镜像、挂载和 HOME 重建以更新运行环境，Candidate 与历史 Run 不变。平台默认可由原生设置覆盖；业务实例末尾运行 Patch 固定这些默认字段，Session 仍可显式选择模型。原有 Session 的显式选择保留。本项只证明默认模型和连接，不构成业务 Evaluation。


- **首页文字任务入口（2026-10-16）**：构建、评测和改进均从描述开始，删除智能体、版本及运行选择区和相关前端依赖；助手继续先查询对象，实际执行仍核对来源并经确认。10 项定向测试、类型检查与构建通过；[正式 3090 页面记录](../platform/plugin/test/evidence/home-text-entry-20261016/acceptance.json)在三种模式和 1440/900/390px 共 9 组检查中确认选择区 DOM 不存在、描述可输入并启用相应动作，无页面错误或横向溢出。此页面观察未发送模型任务，未修改业务资产或用户实例。

- **首页会话创建登记（2026-10-15）**：针对实际首页的 `sessions.retain: unknown session`，改用 DSH 客户端原生 `sessions.create` 即时登记和 `sessions.using` 就绪检查，再向同一会话投递真实任务；已有任务按原身份接续。绑定异常也会释放选择状态。新增回归覆盖列表通知尚未到达、绑定失败不投递任务以及同步绑定异常后继续恢复；客户端 10 项、插件最终 93 项测试和构建全部通过。[修复后实际 3090 检查](../platform/plugin/test/evidence/assistant-registration-3090-20261015.json)确认报错时的原会话保留，首页再次发送“你好”成功、用户消息保持原文、模型为 `deepseek-flash/off`，原生会话控件和实时通道保留，页面异常为零。运行目录两处前端源码/制品已同步并复用原 HOME 重启；未重发或删除用户报错时的消息。


- **管理对话精简布局（2026-10-15）**：[实际 3090 检查](../platform/plugin/test/evidence/conversation-compact-3090-20261015.json)确认品牌行、全局面板列表和欢迎区工作空间行保持隐藏，1440px 与 390px 初次加载默认折叠原生会话侧栏；面包屑旁的按钮调用原生切换，展开后会话列表、工作区、搜索和分组菜单可用，页面往返保留用户选择。宽度、折叠及产物定向检查 3 项通过，类型检查和构建通过。
- **确认卡片与聊天列对齐（2026-10-15）**：`conversation.input.dock` 按原生合同占整行，平台确认区通过两层容器复用原生聊天列的宽度变量与左右留白。[修复前测量](../platform/plugin/test/evidence/proposal-column-3090-20261015-before.json)中，1857px 页面确认区宽 1598px，聊天列宽 920px；[部署后实测](../platform/plugin/test/evidence/proposal-column-3090-20261015-after.json)两者均为 `x=591、width=920`。侧栏展开、480px 助手浮窗、390px 管理页与窄屏浮窗均准确对齐，无横向溢出，单一原生编辑器与长内容滚动保持，确认按钮可达；没有点击业务确认或调用模型。保存[桌面](../platform/plugin/test/evidence/proposal-column-3090-20261015-after-desktop.png)、[浮窗](../platform/plugin/test/evidence/proposal-column-3090-20261015-after-floating.png)和[手机](../platform/plugin/test/evidence/proposal-column-3090-20261015-after-mobile.png)实际画面。源工作树与实际运行目录均完成类型检查和构建，12 项定向检查通过。保留[重启后过早访问的首次探针](../platform/plugin/test/evidence/proposal-column-3090-20261015-startup-attempt.json)；等待认证入口可达后实测通过。原运行目录较新的实例访问和融合校验改动保留，仅同步本次相关源码并从当前源码构建，继续使用原 HOME 与业务资产。

- **智能体管理与独立评测中心（2026-10-15）**：平台新增评测中心，智能体管理使用概览、Harness 资产、能力状态、运行情况四个标签，保留原有 AI 助手、融合版本、特性确认和实例启动。评测中心以测试用例、评测运行、结果比较组织；共享用例可按项保存，Run 报告、动态轨迹清单及报告/单文件/ZIP 下载使用同一原生认证。插件 103 项、仓库及 Run 校验器 65 项、启动器 14 项、评测驱动共 10 项及冻结竞态回归 2 项通过，仓库合同校验无错误或警告。[合并后隔离浏览器记录](../platform/plugin/test/evidence/evaluation-integrated-preview-20261015.json)验证真实全局 DSH 登录、保存与恢复用例、精确深链与前进后退、助手与会话侧栏，以及 1440/900/390px 无横向溢出；客户端错误为零。实际下载上述新 Run 的 21 项 ZIP，最大单文件 180337 字节，逐文件长度与导出清单一致。隔离浏览器没有发送模型消息；模型运行及归因限制见 `PA-10`。

- **3090 实际平台复验（2026-10-15）**：[实际浏览器记录](../platform/plugin/test/evidence/evaluation-live-3090-20261015.json)确认六个导航入口、默认地址补全不造成后退陷阱、研究版本与 Run 深链、报告和完整 ZIP、动态轨迹文件、前进后退、原生会话侧栏和 AI 浮窗；1440/900/390px 无横向溢出，客户端错误为零。源工作树仍是 `/home/admin/work/ai-agent-harness`，原 HOME、账号、模型凭据、工具目录及用户 Profile 均保留；[机器检查与运行状态](../platform/plugin/test/evidence/evaluation-validation-20261015.json)记录进程、日志和停止方式。用例写入在隔离工作树验证后恢复原文，实际 3090 复验只读；未创建新业务版本、启停用户既有实例或修改外部服务。

- **原生侧栏按钮与首页新任务（2026-10-15）**：拉取最新 `cae8a8c` 后保留本地有效改动，移除自建面包屑按钮，保留 DSH 原生按钮及点击行为，仅展示原生展开折叠图标，品牌区域保持精简。[修复前复现](../platform/plugin/test/evidence/native-toggle-home-3090-20261015-before.json)确认此前手动展开后，从首页创建新任务会继承展开状态；会话进入处理现在按原生 frame 的实际折叠状态落实首次进入和首页新任务的收起意图，已折叠时不反向切换，普通跨页保留用户选择。[实际 3090 的 7 项检查](../platform/plugin/test/evidence/native-toggle-home-3090-20261015-after.json)覆盖两次真实首页“你好”、原生图标、双向折叠、跨页选择、390px 与管理对话深链接，页面异常为零。保存[桌面](../platform/plugin/test/evidence/native-toggle-home-3090-20261015-after-desktop.png)和[手机](../platform/plugin/test/evidence/native-toggle-home-3090-20261015-after-mobile.png)实际画面。两处工作树构建及 14 项定向检查通过。[首次探针](../platform/plugin/test/evidence/native-toggle-home-3090-20261015-attempt01.json)因错误假定原生按钮一定配置快捷键而中断；原生未配置该快捷键，移除该假定后通过。保留本地未提交改动及拉取前备份，没有执行待确认的业务操作。

- **本轮提交前回归（2026-10-15）**：基于最新 `cae8a8c`，插件类型检查、构建及 130 项 Node 检查、启动器 17 项、容器适配器 100 项和仓库验证器 66 项检查全部通过，共 313 项。凭据测试夹具已与启动器的 JSON 合同一致；验证器的子进程同样通过显式 PATH 使用 Python 3.10，避免 shell 默认 Python 3.8 误报。提交范围的文档本地链接、JSON/JSONL 解析、差异空白与实际凭据排除检查通过。上述范围不替代业务 Experiment Evaluation 或 Research Release 复现。

- **main 整合与管理对话取舍（2026-10-16）**：整合 `749ef22` 与变体功能提交 `2a58cd8`，管理对话、确认卡、浮窗及原生侧栏沿用功能分支样式，仅限定公共链接色和触屏变量的作用范围；其他页面保留 main 改动。[样式核对](../platform/plugin/test/evidence/main-merge-20261016/assistant-style-restoration.json)确认去除这两行限定规则后与功能分支逐字节一致。插件类型检查、构建与 437 项测试、适配器 9 项、快照 8 项检查通过；首次依赖链接越界通过独立安装同锁依赖解决，新增原生管理器测试补齐 Cordis 接口桩。[变体及相邻页面复验](../platform/plugin/test/evidence/main-merge-20261016/merged-browser.json)9/9 通过，135 份[运行源码](../platform/plugin/test/evidence/main-merge-20261016/merged-source-sync-final.json)与隔离预览一致。运行器摘要变化使旧构建与比较不能恢复为当前已验证；原不可变回执及 22→16 历史观察保留，本轮没有重建业务变体、调用模型或新增 Run。首次错误等待旧状态的[脚本记录](../platform/plugin/test/evidence/main-merge-20261016/merged-browser-attempt01.json)保留。

  [管理对话复验](../platform/plugin/test/evidence/main-merge-20261016/management-browser.json)完成既有会话、任务、原生侧栏、1440/390px 与浮窗的 5 项可见检查，页面异常为零；整体脚本未通过，保留两条原生辅助请求 `404` 及 UI 自动创建一次空 Session 的实际记录，未发送消息或调用模型。[首次隐藏历史卡定位失败](../platform/plugin/test/evidence/main-merge-20261016/management-browser-attempt01.json)亦保留，没有改写为成功或扩展修改原分支布局；本轮未捕获待确认卡。最终预览为 `http://10.0.160.32:3115/hep/`，进程、日志及停止命令见运行源码记录。本轮未操作 3090；最后只读复核其 PID 为 `3933870`，与开始观察不同，已追加更正早期“保持不变”的表述，未核对其他任务的变更。此项仅证明程序整合与界面取舍，不提升业务 Evaluation 或 Research Release 结论。

- **再次整合最新 main（2026-10-16）**：随后整合 `0fa526b`，保留数据根管理资产加载与 `runtime/research/` 工具迁移，排除新增的原生会话主题，管理对话、浮窗与侧栏继续沿用功能分支布局；独立的通用设置弹窗与菜单样式保留。迁出的业务 Skill 不恢复为程序副本；现有 `compute-variants/context` 通过[程序合同](../platform/plugin/src/agents/compute-generation-contract.ts)提供准确的 SDK、实际工具、构建、冻结及装载接口，研究方法仍由数据工作区维护。连续任务按真实计划种类选择变体专用 Skill，不退回普通构建上下文。类型检查、构建及最终插件 455/455、Runtime API 11/11、Run 快照 8/8 通过，仓库校验无错误或警告。首次全量的 453 项中，旧作用域夹具缺少新增的原生技能服务而失败一项；补齐真实 SkillRegistry 与文件提供方后，专项及全量复验通过，未放宽程序的资产配置检查。

  前一轮的截图与 3115 来源证据仍指向 `749ef22` 整合阶段；此次没有重新部署第二轮整合程序、更新外部数据仓库或调用业务模型。新程序合同的 2 项回归包含公开导出、类型和入口的真实固定编译，不能替代迁移后新的模型生成任务或业务 Evaluation。

- **MCP 分组 v2 与业务 Harness 迁移机器合同（2026-10-20）**：MCP 管理服务保留旧分组链接的 v1 工具名和摘要，新 `/hep/mcp/groups/<id>/v2` 用来源 ID 生成稳定工具名，分组可选择工具、资源 URI 与模板并代理读取；三个管理页移除重复标题说明。固定编排绑定改用 v2 摘要和同进程受控调用。业务 Runtime 的分组请求按实例、公开路径、RPC 内容和当前 Session 逐次签名，平台拒绝重放、错路径、替换 RPC 与无 Session 执行；带无效业务签名的请求不会降级为 Bearer，外部客户端仍可用分组 Token 直接访问。资源和工具的取消信号传至实际来源。最终程序插件类型检查、构建及 610 项 Node 测试通过，测试进程显式使用 Python 3.10（当前 shell 默认 Python 3.8 会使既有研究脚本失败）。数据侧从固定 EXP-022 独立派生 `EXP-security-operations-expert-024-rad80a907c628` Candidate，保留原版本与实例，按当前来源解析工具名及资源映射；Candidate Node 合同 44/44、Python 合同 11/11、数据仓库合同校验 0 错误及 0 警告。此处证明程序协议和受控夹具；当前 3090 进程尚未重启装载新程序，业务实例未切换，真实第三方 SOC 效果、新业务 Run 和 Research Release 均未验证；`PA-03/04/06/08/12` 的实机状态不因此提升。

- **平台 MCP 配置迁移与隔离恢复（2026-10-20）**：现场旧用户 `cordis.patch.yml` 的原始 SHA-256 为 `c1f2cdb6019d9f0e3839152363049026ac2eab41c007830201dc8683f72a33e0`，以 `0600` 权限备份于本地忽略目录；其中 3 项服务、2 个分组迁至数据根 `config/mcp-manager.json`，共享 Token 和服务凭据分离至被 Git 忽略的 `.local/credentials/mcp-manager.json`，原 Patch 仅保留其他原生设置。平台专用 manager 入口不向原生 Settings 暴露可写 Config，业务 Runtime 仍使用自身原生配置。启动器 34/34、程序插件 610/610 项测试通过。在无平台 HOME 的隔离数据副本重新 `prepare` 后，保存回读、旧 `revision` 拒绝、真实 Cordis 新 Session 装载 22 个工具及 v2 分组摘要均通过；隔离写入未改现场数据。现场重新 `prepare` 后启动预检通过，用户 Patch、数据配置和本地凭据摘要保持不变。当前 3090 进程尚未重启，新的真实 UI 保存链未在该进程验收；第三方 SOC 效果、新业务 Run 与 Research Release 仍未验证。

## 4. 为什么是 12 条

| 稳定入口或能力 | 归入路径 |
|---|---|
| `AGENTS.md`、项目审查原则、`harness-guided-workflow`、Memory、AI 纠错记录 | `PA-01`、`PA-03` |
| `SOURCES.md`、受控副本、项目解释 | `PA-02` |
| 三个资产/研究校验工具 | `PA-03` |
| `source_contract.py` 与角色挂载计划 | `PA-04` |
| `dsh-dev up/ps/url/logs/down/delete` | `PA-05` |
| 镜像构建、容器装载和边界探针 | `PA-06` |
| `mutation-receipt.py` 与宿主开发会话 | `PA-07` |
| `dsh-eval`、DSH Runtime API/Web UI、Session、消息与轨迹导出 | `PA-08`、`PA-10` |
| Preset 创建、登记、重载和选择 | `PA-09` |
| `run_record.py` 的 Run 记录、索引、查看与比较 | `PA-10` |
| Research Release 清单、解析和复现 | `PA-11` |
| `platform/dsh-platform`、平台 Cordis Host/客户端、平台密码登录、六页研究工具与 MCP Gateway | `PA-12` |

单元测试、负向样例、日志和证据文件用于证明某条路径，不因数量增加而成为新的一级路径。某个 Experiment 使用 1 个还是 100 个输入，也不改变项目级路径总数。

## 5. 哪些验证应该进入测试

| 验证类型 | 建议位置 | 原因 |
|---|---|---|
| 解析、schema、路径、摘要、状态转换、失败分支 | `tests/` 或 owning module 邻近的测试 | 稳定、快速、可重复，适合每次变更回归 |
| Docker 挂载、镜像、DSH 进程和实际装载 | 适配层探针；必要结果放 Experiment `evaluation/evidence/` | 依赖真实运行环境，单元测试不能替代 |
| Web 工作区、Session、消息和用户可见结果 | 浏览器 E2E 或带步骤的人工实录 | HTTP `200` 无法证明完整用户路径 |
| Harness 行为变化 | 对应 Experiment 的 Run、观察和 Decision | 结论依赖具体假设、输入、模型和环境 |
| Research Release 复现 | Release 清单检查加真实重新装载记录 | 静态完整性与实际行为需要分别证明 |

原则很简单：稳定、确定、可重复的合同进入自动化测试；依赖真实模型、MCP、浏览器或容器的路径保留可复现步骤和实机证据。二者不能互相替代。

## 6. 维护规则

- 项目治理、CLI、适配层或工作流变化时，先标出受影响的 `PA-xx`。
- 总数、总览行数和“为什么是 12 条”的入口映射必须一致。
- 新证据与该路径的完成标准一致时才提升状态；依赖变化或证据失效时应降级。
- 本矩阵不复制某个 Experiment 的输入、阈值或结论，只链接其主要事实源。
- 完成工作时分别报告：机器合同、真实运行路径、Experiment 结论和未验证项。
