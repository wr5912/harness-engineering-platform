# DSH rc.2 升级与兼容验收（2026-10-19）

两套管理平台与四个业务容器已实际升级至 DSH `0.2.1-rc.2`。本记录覆盖 `PA-05/06/08/12` 的版本、装载、接口和限定业务路径；不改变全项目路径状态，也不构成 Harness 效果比较或 Research Release。

范围说明（2026-10-19 补充）：本记录中的“小模型管理平台”和“小模型巡检”使用本平台程序仓库与数据仓库各自的另一份 Git worktree，供小模型适配试验使用。“独立项目”是当时不准确的称谓；独立目录、分支、数据根和 HOME 是运行事实，不代表另一个平台产品或架构子系统。下列历史验收范围及原始 JSON 保留，当前平台架构图不包含这组实验部署。

## 运行入口与归属

| 入口 | 程序与数据归属 | 本轮验证 |
|---|---|---|
| [主管理平台](http://10.0.160.32:3090/hep/) | `ai-agent-harness`；`~/harness-engineering-platform-data` | 密码登录、六页、真实管理模型轮次、已发布只读组合 |
| [小模型管理平台](http://127.0.0.1:3124/hep/) | 独立 `hep-small-model-platform`；`~/work/hep-small-model-data` | 原本仅绑定本机；六页、独立管理资产、真实模型轮次 |
| [SOC](http://10.0.160.32:3081/assistant/) | 主数据根，`EXP-security-operations-expert-019-rc442472a242a` | 真实模型与只读 MCP 查询、旧会话、语音入口 |
| [test01](http://10.0.160.32:3089/assistant/) | 主数据根，`EXP-test01-002` | 原生目录变量兼容后的真实模型轮次 |
| [交付演示](http://10.0.160.32:3114/assistant/) | 主数据根，`EXP-inspection-delivery-demo-001-rf841e4415364` | 基础 Mock 巡检、Markdown/CSV 下载与摘要校验 |
| [小模型巡检](http://10.0.160.32:3125/assistant/) | 独立项目与数据根，`EXP-daily-inspection-assistant-006-r2843ec359b07` | 基础 Mock 巡检、Markdown/CSV 下载与摘要校验 |

以上 URL 在宿主机浏览器验证，未用另一台设备验证网络连通性。第四个业务容器归属独立小模型工作区，未迁入主数据根。端口、实例名、来源、HOME 和既有访问方式保持原设置；本次没有部署统一业务网关。

[运行快照](running-inventory.json)记录 PID、程序提交、产物摘要、实际 Runtime 版本和容器挂载。四容器共用标准镜像 `ai-agent-harness/dsh:687f282e8-b9bce5f1fe5f`，实际 Image ID 为 `sha256:1c777fe4929a41275ba5bcd899877aaa156f8f166975254840f52b26703eca90`。[构建记录](image-build.json)锁定官方提交 `687f282e8625c6b8d11ff58211a90524be2e4317`、tree 和依赖摘要；仅构建本地镜像，未发布到镜像仓库。

## 实际行为与证据

- 管理平台：[主平台六页与浏览器](main-live.json)、[模型轮次](main-live-readiness.json)、[小模型平台六页](small-live-repeat.json)、[独立管理资产与模型轮次](small-live-readiness.json)。均完成桌面、390px、刷新、品牌与双向 WebSocket 检查。主管理模型保留原有 `max`，独立平台与业务容器使用 `off`，未为升级统一用户模型偏好。[主平台](main-live-stability.json)与[小模型平台](small-live-stability.json)各 20 次连续只读请求通过。
- 主平台实际调用已发布只读组合，两个 GET 叶子调用成功，见[组合回执](platform-readonly-mcp.json)。当前连接与组合配置保留，不能据此宣称动态风险权限已实现。
- 四业务容器的新 Session 均以实际 `deepseek-official/deepseek-flash` 完成。桌面、390px、原生设置页、刷新与双向 WebSocket 检查通过，完整索引及摘要见[业务证据清单](business-evidence-manifest.json)。
- [交付演示](business-delivery-task-1.json)与[独立小模型巡检](business-small-task-1.json)各执行 5 次 `task_inspection`，覆盖固定 5 台模拟设备的分页、报告生成与下载；CSV 均为 6 行，报告 SHA 与工具回执一致。该任务读取基础 Mock 台账，不检测真实设备。
- [SOC 工具回执](business-soc-query-result.json)确认 `list_executable_inspections` 返回业务 `code=200`、`items=1`；没有执行处置或策略配置。[语音检查](business-soc-voice-readonly.json)只覆盖入口显示与只读配置路由，没有录音、ASR、TTS 或语音质量结论。
- 真实旧会话可列出并导出：[SOC](old-security-operations-expert-eval.json)、[交付演示](old-hep-inspection-delivery.json)、[独立小模型巡检](old-hep-small-model-inspection.json)。使用升级前已存在且含消息、工具的会话；test01 原本没有旧会话，不作历史迁移结论。

## 固定 Harness 的原生兼容

兼容发生在程序侧只读运行投影和插件中，未修改原 Candidate。原生目录变量、Schedule、委派和评测解析的维护说明见[容器适配器](../../../../../runtime/adapters/dsh-container/README.md#候选资产装载)。

[隔离 HOME 实机探针](runtime-compat-probe.json)使用本轮同一标准镜像和 SOC 固定来源，通过 Schedule 增删改查、到期投递、时间上下文、重启恢复、原会话关联、前台子模型结果与取消。三个子角色保留各自 Persona 和工具白名单，Schedule 对子角色隐藏且直接调用也被原生拒绝。发布后取消观察为 484ms，不能推导成其他机器或网络的延迟保证。17 份原 Session 压缩文件逐字节保持，临时容器与专用 fallback 卷已清理。

[升级前 Schedule 盘点](schedule-baseline.json)完整解压四实例全部 20 个旧 Session、819 条事件，用旧 Runtime 原生折叠逻辑核验，无 Schedule 事件和活跃任务。实际升级没有需要迁移的活动任务；新任务的恢复行为由上述隔离探针验证。

## 自动化与构建

实现提交为 `e8f4839`（管理平台）、`651824c`（业务 Runtime）；设计提交为 `157d07f`。独立小模型程序同步提交 `960707b3da60e79b286361d249fd5d33f098a598` 只包含本轮共享兼容代码；原有未提交工作完整保留，未整分支合入主线。

| 检查 | 已执行结果 |
|---|---|
| 平台 `pnpm --dir platform/plugin test` | 构建、类型检查、521 项通过 |
| 平台启动器 | Python 27 项通过 |
| 独立小模型程序 | 类型检查、构建、相关 Node 21 项与启动器 27 项通过 |
| 容器适配器 `/usr/bin/python3 -m unittest discover -s runtime/adapters/dsh-container -p 'test_*.py'` | 186 项通过；最后路径调整后 `test_dsh_dev.py` 127 项再次通过 |
| Profile、匿名接入、Web 挂载与真实锁定镜像清单 | Node 13 项通过 |
| 评测事件解析、关联轨迹、交付合同 | 分别 16 组、11 项、3 项通过；覆盖提示词组装前失败和成功后失败时的旧模型信息污染 |
| 官方镜像构建 | 官方 9 gates 全通过；使用官方 `DSH_GATE_CONCURRENCY=1` |

这些检查部分重叠，不合并计算总测试数。构建早期存在网络和并行构建资源失败，最终串行构建通过；没有因此跳过官方 gate。

## 失败、保留与边界

[test01 首次失败](business-test-readiness-1.json)由旧 Persona 的 `cwd` 变量不再注册引起。程序通过原生 `workingDirectory` 服务兼容后，[同来源新 Session 重试](business-test-readiness-2.json)完成。原失败 Session 与记录保留。评测解析器同时支持新版组装前失败事件，不再等到超时或误用上一轮模型信息。

管理平台首次检查分别出现 [ECONNRESET](main-live-first-attempt.json) 和[原生接口请求中断](small-live.json)，随后复测及连续请求检查通过；未确定唯一根因，不将复测通过写成故障根因已解决。早期 test01 浏览器探针未按真实“账号菜单”定位设置按钮，调整探针后通过，未修改产品来迎合探针。

所有实例切换前均停止写入并备份 HOME、登记和旧部署；私有恢复点位于 `~/.local/state/hep-rc2-upgrade-20261019/`，不进入 Git。旧 Runtime fallback 卷保留。本轮未执行回退演练。原始 Session ZIP、业务截图、报告、环境与 Docker inspect 仅在私有目录保存；本目录仅纳入脱敏摘要。

[独立程序保留检查](fork-preservation-final.json)逐字节核对 739 个预期跟踪文件及 21 个原有未跟踪文件，没有额外改变。[数据仓库核验](data-repository-verification.json)确认两个数据根的跟踪差异与任务开始时完全一致，原有未跟踪文件保持；本轮没有可提交的业务资产变化，因此未创建数据空提交。

管理进程可用 `kill -INT <running-inventory.json 中的 PID>` 停止，业务容器可用 `docker stop <实例名>` 停止；这些操作不会删除 HOME。本轮恢复的基础 Mock 53001 进程为 `1129116`，日志和停止方式见[证据清单](business-evidence-manifest.json)；既有 53002 等外部服务未改动。

统一业务入口、四类插件、共享 Runtime 用户数据隔离和 MCP 动态风险联动仍是[已选未来设计](../../../../../docs/platform-design/README.md#已选的业务运行演进)。本轮容器仍使用 host 网络与既有访问方式，不能称为已完成网络或多用户隔离。真实外部业务、完整质量评测及长期运行稳定性未由本次验收覆盖。
