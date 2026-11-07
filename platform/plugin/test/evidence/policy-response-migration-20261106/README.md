# 策略配置与应急处置迁移验证（历史）

本记录对应已经撤销的八包及本地操作台账方案，保留当时的验证与失败事实；当前结果见[接口接入与固定流程分工核验](../policy-response-raw-20261106/README.md)。下文已删除源码及测试名称仅作历史定位，不能作为当前能力入口。

对应 `PA-12` 的 MCP 编排及 `PA-08` 的业务使用方验证。时间为本地 2026-11-05（UTC 11-06）。按用户最新要求，八个编排保持编辑草稿，先完成迁移及草稿核验，再共同优化节点复杂度；暂不发布、切换业务工具绑定或办理真实 SOC 草案创建。

业务范围、来源和逐包入口统一见数据仓库的[迁移方案](/home/cmp/harness-engineering-platform-data/mcp/docs/policy-response-migration.md)。外部 `ai-lite-platform` 只读，未纳入整改。

## 平台与工具验证

本次补齐公开 `WorkflowContext.operations`，由平台保管跨 Run 的原操作、冻结快照、修订、命令槽及制品；实际接口见 `platform/plugin/src/mcp/composition-operations.ts`（后续已删除）。写命令先持久化再调用外部接口，重复槽回读原命令，失去回执保留未知。LFX 回调使用冻结 TypeScript 组件和子包；单节点调用不隐式缓存或重试。含写入的编排保留明确的 `readonly:false`，原巡检保持只读。

| 验证范围 | 本次结果 |
| --- | --- |
| 平台定向回归 | `node --test test/mcp.test.mjs test/mcp-lfx-assets.test.mjs test/mcp-lfx-runtime.test.mjs test/mcp-workflow-runs.test.mjs test/mcp-composition-operations.test.mjs`：53/53。覆盖旧巡检、命令竞争/重入、未知回执、纯查询、失败 Run 制品及真实官方 LFX HTTP 固定子包与 TS 回调。 |
| 官方 LFX 运行层 | 锁定 Python 执行 `platform/mcp/lfx/test_runtime.py`：7/7。覆盖互斥路径、浅层/深层分支独立终止出口、固定子包、批量顺序/并发、取消及本地 HTTP。 |
| 数据适配器与构建依赖 | 归拢公共测试后，在数据根执行 `node --test mcp/tests/test.mjs mcp/tests/test-policy-response.mjs`：20/20。覆盖公开 OpenAPI 的 path/query/body 分配、Schema 类型和实际 TS 导入依赖。 |
| 公共测试目录与运行入口 | 公共测试及夹具集中到数据侧 `mcp/tests/`，组合专属测试仍属各自包。新路径巡检原生流程回归通过（六种流程），LFX 基础夹具 6/6；当前受影响的本地链接与导入已核对，历史记录不改写。 |
| 最新公共目标解析与原操作观察流程 | 官方 LFX 真实 Graph、真实冻结 TS 及公开 host，SOC 边界隔离：48/48、零 SOC 写入，见 [suite-mg8ehF](/home/cmp/harness-engineering-platform-data/mcp/.local/policy-response-fixtures/suite-mg8ehF/report.json)。 |
| 公共策略草稿流程 | 同一隔离边界：55/55，见 [suite-wabLsi](/home/cmp/harness-engineering-platform-data/mcp/.local/policy-response-fixtures/suite-wabLsi/report.json)。不能替代真实 SOC 创建、审批或设备效果。 |
| 单点策略与原待办审批 | 最新官方 LFX 复验 34/34，见 [suite-ze5n77](/home/cmp/harness-engineering-platform-data/mcp/.local/policy-response-fixtures/suite-ze5n77/report.json)。覆盖覆盖关闭、目标歧义、不完整规则、草稿绑定、原号续查、审批凭据缺失及唯一待办；SOC 为隔离回包。 |
| 应急跨 Run 生命周期 | `node --test mcp/tests/test-policy-response-lifecycle.mjs`：5/5。覆盖修订/取消使旧执行失效、明确执行只提交一次、丢失回执后不重放、唯一待办审批及动作目录变化阻断。查询未改操作文件。 |
| 评测启动参数一致性 | `node --test test/evaluation-jobs.test.mjs`：43/43。真实管理助手暴露通用执行附加 `confirmed:true` 被误计入业务参数摘要的问题；修复后相同冻结参数可启动，实际参数变化仍拒绝。 |

早期官方流程测试发现，多条互斥端口直接连共享顶点会混入未选值；隔离分支顶点后，深浅终止路径共用一个总出口仍可能等待已跳过的深层依赖。保持官方 LFX 调度器，终止路径分别使用独立输出顶点，业务结果函数可复用；只在后续确有共同步骤时汇合。运行层已固化回归，最新单点、审批和应急生命周期复测通过，旧失败报告保留。

## 真实联调与装载边界

管理助手完成原始 SOC 的只读发现、动作目录和部门树查询；framework 连接已登记，但访问凭据缺失，真实审批未验收。实际接口及回执摘要见数据侧[只读联调记录](/home/cmp/harness-engineering-platform-data/mcp/.local/policy-response-live-readonly-20261106/README.md)。HTTP 200、目录存在与静态 Schema 均不证明动作可执行或设备效果。

`platform/dsh-deploy update --json` 完成构建暂存后返回 `busy`、`activation:none`，最新回执为 `.local/platform-updates/ba6a184f-4f3a-49c9-959d-d5aed4988340/receipt.json`。本任务管理助手已保存交接，另一个用户会话仍在运行；未强制停止、未绕过维护工具装载，也未修改远端部署。新平台代码的真实保存回读、发布和固定子版本嵌套仍待装载后验证。

用户指定业务验收与 Harness 整改仅使用 `EXP-security-operations-expert-027-f-r5efdc136f237`。管理助手修复该 Candidate 的可选确认配置启动硬依赖，并通过受控入口定向重载 `policy-response-027-acceptance`（端口 18500，保留 HOME、会话、模型和镜像）。回执 `9647f38c-2e87-46c6-8b07-4596525c51af` 于 `2026-11-06T06:11:26.383Z` 核验实际装载，回读 `asset_status=current`；旧启动失败保留在该 EXP 的[观察记录](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/evaluation/observations.md)。这不证明新会话、旧确认动态路径或迁移业务通过。

真实浏览器只读打开单点策略草稿，原生分支图可见，未发现页面异常或告警；[截图](policy-single-draft-canvas.png)与[页面观察](draft-canvas.json)保留时间和对象。未执行或发布组合，后续仍需核对固定子包详情及实际调用。

管理助手两次以 `U-QA-004`、`U-POL-007` 预览并启动评测；预览与启动的业务参数一致，但被上述确认标记摘要问题拒绝，两个预留 ID 为 `6236c885-06e0-4175-97b1-a344a0916ff8`、`11bff6ed-ccb2-4956-b536-6f84e8a27ed7`，均未创建实际 Run。修复尚待平台装载及原助手复验，不将预留 ID 当评测结果。

用户已提供防火墙 `172.16.1.1`、源 `172.16.1.151` 分别到 `172.16.1.165`、`172.16.1.100`、`172.16.1.160` 的 ALLOW TCP 443 草案验收输入，禁止提交、审批和执行；跨网段示例明确暂不验收。随后用户要求先保留八个编排草稿、共同优化，因此真实草案创建及使用方验收暂缓。输入由指定 EXP 的验收会话保存，原始 SOC 只读身份查询可收尾，不把查询结果当草案通过。framework 真实审批凭据仍未配置。本轮无业务 Evaluation 结果或 Research Release，不提升相关路径整体状态。
