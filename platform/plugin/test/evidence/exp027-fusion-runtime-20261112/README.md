# EXP027 融合、启动与策略组合发布核验

核验时间：2026-11-12 UTC。范围覆盖三特性融合主线、只读 `workspace` 下的 `.env`/依赖初始化、MCP 组合发现，以及用户要求发布的 `policy_change`。

## 已完成

- 数据仓库 `main` 已提交并推送 `deded0c15d7a23c25316ef588b1e1ea5f3fa0b81`。本次提交只包含 `mcp/compositions/policy-change/composition.json`，远端 `main` 摘要一致。
- `policy_change` 已从草稿发布为固定版本 `ae580a422cf607df8b24f7c84226983fa3cf80fa8b016e386a323ea2a0552ef8`，当前无草稿；发布实现摘要为 `5c35af4ae29747498b63d3bdc36c325e0db0a6c6371bda34d2a73de0917979e8`。发布前后 dry 校验均通过且没有上游请求。
- 主干实例 `18503` 与反馈实例 `18504` 均通过平台生命周期入口重启，重启时分别保留 38、105 个历史会话，重启后无执行中会话；随后新增的主干只读核对会话使当前数量为 39、105。两实例的 `policy-response-acceptance` 均实际发现 `policy_change`、`emergency_action`。
- 两实例的同名 `policy-change` 草稿绑定已解除，保留尚未发布的 `xx-device-policy` 联调绑定，避免草稿遮蔽固定发布工具。11 个业务分组在两实例上协议发现均无错误；主干新原生会话的 `request/header` 实际包含 `mcp__policy-response-acceptance__policy_change` 和 27 个 `policy-response` 原始工具，且本次核对工具调用数为 0。发现记录包含各自实例名和观察时间。
- 启动根因已按共同路径修复并验证：只读 workspace 的受控文件挂载有实体占位；依赖回退只从同一镜像安装闭包构造；容器内 HOME 与受控挂载验证通过。

## 根因与边界

此前 `.env` 挂载失败的根因是资产筛选排除了受控注释型 `.env`，融合结果缺少只读 workspace 中的子文件挂载点。现将规范占位纳入完整 Candidate 合同，编辑、融合、装配、来源解析和启动共同核对最终文件树。

`home-init` 的初始化代码仍依赖锁定 Runtime 已取消的 `healProfilesModuleFallback`，并拒绝复用既有安装链接；另建挂载卷还会遇到 UID 1000 的写入权限问题。现在复用原有初始化卷，在原生 healer 缺失时按同一镜像的安装闭包生成并校验链接，再只读投影给 Managed 插件。运行中容器核对该导出为 `undefined`、进程 UID 为 1000；新卷初始化与重复启动均通过。修复不改变根文件系统的只读合同，也不安装另一份 DSH。

此前组合缺失的根因是实例草稿绑定在已发布服务发现时以异常方式阻断同一 MCP 服务，且报告实例没有绑定 `policy-change` 草稿。现在失效绑定与公开发现分离，发布后清理了两个实例的同名草稿绑定；`policy_change` 由固定发布版本提供。

## 证据

- [acceptance-summary.json](acceptance-summary.json)：发布、实例、发现、启动检查和边界摘要。
- [composition-dry-summary.json](composition-dry-summary.json)：11 个组合的结构 dry 与零上游请求回执；记录各次选择的草稿或发布状态，不代表真实外部业务通过。
- [discovery-main.jsonl](discovery-main.jsonl)、[discovery-policy.jsonl](discovery-policy.jsonl)、[native-tool-header.json](native-tool-header.json)：两个实例的 11 组实际 `tools/list` 与主干 DSH 原生工具 header。
- [home-submounts-container.log](home-submounts-container.log)、[docker-bootstrap.log](docker-bootstrap.log)、[docker-status.txt](docker-status.txt)：容器挂载、bootstrap 回归与收尾容器状态。
- [dsh-dev-regression.log](dsh-dev-regression.log)：实例启动器与来源解析相关 162 项回归通过。
- [mcp-regression.log](mcp-regression.log)、[compositions-full.log](compositions-full.log)：MCP 34 项、组合相关 234 项回归结果。
- [main-detail-desktop.png](main-detail-desktop.png)、[main-detail-mobile.png](main-detail-mobile.png)、[main-detail-snapshots.json](main-detail-snapshots.json)：发布后刷新主干详情的桌面与窄屏核验，均显示运行中和资产已生效，无横向溢出。
- [host-home-probe-failure.log](host-home-probe-failure.log)：保留错误调用方式的失败证据；容器验证合同通过，见上方。

## 尚未证明

真实 XX MCP 尚未配置，`xx_device_policy` 只保留为联调草稿；本轮没有调用策略写入、提交或下发，也没有把 dry、启动、工具发现或模型回复写成业务 Evaluation/Research Release 通过。三特性融合资产及启动占位已由先前的 `b220b910`、`8a4b22ff` 推送；融合研究保持 `integrating`，`merged-load` 与 `merged-capability` 仍需相应研究证据。程序根修复仍在本地未提交工作树，数据仓库存在并行未提交修改；本次追加发布只提交了策略组合唯一事实源。
