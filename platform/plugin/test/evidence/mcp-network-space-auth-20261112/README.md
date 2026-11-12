# 网络空间监控 MCP 鉴权核验

核验时间：2026-11-12 UTC。对应 `PA-12`，并核对受影响实例的 `PA-05/06/07/08` 相邻路径。范围为本机平台与 `network-space-027-r6930a1922fdc` 的资源查询，不代表完整业务评测通过。

## 接口来源与根因

`GET api/security-operations/network-space/threats` 是目标 Candidate 中 `dsh/managed/security-network-space/index.js` 注册的页面接口。其 `mcp.js` 将 `threats` 映射到已配置分组 `network-space-monitoring` 中的 `ai-soc-correlate` 资源 `/correlate/incident`；固定条件为 `judgeStatus=DONE`、`judgeVerdict=TRUE_POSITIVE`、`severity=CRITICAL`、第 1 页、50 条。数据根 `mcp/manager.json` 保存服务规范地址 `http://172.16.138.223:18085/v3/api-docs/mcp` 及相应资源模板；实际业务路径为该服务的 `/correlate/incident`。

原插件自行连接平台 MCP，依赖未配置的 `DISPOSITION_MCP_TOKEN`，并尝试使用业务上下文中有意不公开的 `currentGroup().token`。实际结果是缺少有效 Authorization，18120 在连接阶段返回 401，尚未发现或读取资源。仅凭该错误不能断言发送了字面值 `Bearer `。

插件改用现有 `ctx.mcpSessionManager.groupUrl/groupFetch`，由平台传输提供当前凭据和真实实例上下文，配置仅保留分组 ID。连接恢复后，真实请求进一步暴露网关将匿名页面资源读取误判为必须带对话 Session，返回 `business_context_invalid`。平台[共同入口](../../../src/mcp/manager.ts)现允许具有有效匿名实例上下文的 `resources/list`、`resources/templates/list`、`resources/read` 无 Session 读取；固定实例、上下文及目标核对仍然生效。

本次覆盖所有共用该 reader 的监控查询及其调用方、配置和测试，未修改 DSH 或外部服务源码。

## 工程验证

| 检查 | 结果 |
| --- | --- |
| `platform/plugin` 类型检查及隔离构建 | 通过 |
| 业务访问、网关、MCP 分组及平台入口 8 个定向测试文件 | 171/171 通过 |
| 原工作区 `instances.test.mjs` | 34/34 通过 |
| 容器业务适配器 `test_business.mjs` | 23/23 通过 |
| Candidate `security-network-space/test-contracts.mjs` | 31/31 通过 |

[分组回归](../../business-group-v2.test.mjs)覆盖匿名页面的资源发现与读取、缺失上下文拒绝、需认证实例无 Session 拒绝、无 Session 工具调用拒绝，并保留原签名和重放检查。插件回归确认请求委托给平台传输，连接错误仍保留真实阶段和 HTTP 状态。

首次在隔离镜像工作区合跑 9 文件为 205 项、196 通过、9 失败，失败集中在实例网关登记夹具；原工作区实例文件 34/34 通过，隔离工作区其余 8 文件 171/171 通过。保留首次失败，不将其记为全通过或全仓回归。

分组文件最终单独复核为 2/2 通过。宿主机运行时通过 `HARNESS_DSH_ENTRY` 指向锁定版 DSH 的实际 `package.json`；未设置时曾因默认容器 SDK 路径不存在而失败，该次环境失败不计为回归通过。

## 本机生效与真实结果

用户明确允许中断管理会话后，通过维护入口 `platform/dsh-deploy update --interrupt-sessions` 应用平台修复，回执为 `applied / managed-restart`，Runtime PID 为 `2913632`，工作区身份保持。部署回执位于程序根 `.local/platform-updates/8d27236c-d8cc-499e-be49-cc048477db37/receipt.json`。

目标业务实例通过平台生命周期入口定向重载，保留 HOME 和端口 `18500`，其余 9 个运行容器的身份与启动时间未变。原 64 个 Session 全部保留，63 个解压内容摘要不变；1 个空白 Session 的配置种子变化，仅含 Session、权限、沙箱、审批及结束种子事件。浏览器检查后共 65 个 Session。指定原管理会话文件仍存在。

02:55 UTC 经目标实例真实统一网关读取，回执均为 `simulation=false`：

| 查询 | 业务结果 |
| --- | --- |
| `threats` | `status=ok`，8 条、总数 8、无错误 |
| `assets` | `status=partial`，第 1 页 20 条、总数 108，明确未完整分页、无错误 |
| `incidents` | `status=empty`，默认近 24 小时为 0 条、无错误 |
| `topology` | `status=unavailable`，`stage=read / QUERY_ABORTED`，10 秒查询预算内未完成；不是连接 401 |

03:01 UTC 使用项目现有浏览器驱动，在真实业务入口点击“网络空间监控”，等待“已读取真实研判结果”成功；[实际截图](threats-viewport.png)及可读快照显示“重点关注”8 条真实记录。页面其余区域仍标明交互原型、包含模拟数据，本次只确认威胁区的数据读取恢复。无 Authorization 的平台 MCP 初始化直连仍返回 401，负向检查通过。

原始测试、更新回执、查询摘要、保留检查及浏览器快照与追踪留在程序根 `.local/mcp-network-space-auth-repair-20261112/`；不纳入凭据、Cookie 或原始对话正文。

## 保留的问题与验证边界

目标实例另缺少 `instance-confirmation-config` 要求的专用签名配置，插件日志报配置未就绪，整包加载观察器未返回回执。因此生命周期重载结果保持 `unknown`；真实威胁读取成功仅证明本次传输修复已装载，不将其写成全部资产均已完成装载。不生成替代凭据、不禁用相关插件、不自动重放重载。

拓扑读取超时保持失败。本次未修改外部服务、运行完整业务 Evaluation、生成 Research Release、同步远端或提交推送 Git。
