# 统一网关智能体选择器与紧凑状态栏验收

日期：2026-10-20。按用户采纳的建议，将 Agent ID 自由输入改为现有智能体选择；同时按补充要求移除页内大标题，将四张状态卡片收紧。当前职责与交互合同见[插件规范](../../../../../docs/platform-design/20_业务访问与运行控制插件开发规范.md#统一网关界面与配置)，本记录只保存本轮验证事实。

选择器复用智能体管理的 `agents/list`，支持名称和 ID 搜索、只读关联 ID、查看已有版本与业务实例来源。找不到的已配置身份保留原值；读取失败和空目录分别显示。更换对象不会继承原来源与身份启用，也不会自动开放业务访问。

| 验证 | 实际结果 |
|---|---|
| 构建与类型检查 | `platform/plugin` 下 `pnpm run build` 通过，包含 `tsc --noEmit` |
| 针对性回归 | 控制核心、管理接口、导航共 50 项通过，见[测试日志](tests.log)；覆盖搜索、未知身份保留、失败重试、迟到读取不覆盖新列表、草稿保留及保存字段兼容 |
| 实际界面 | 原管理账号登录 [3090](http://10.0.160.32:3090/hep/#/gateway)，可选择 6 个真实资产；名称／ID 搜索、只读 ID、版本与业务实例说明、三类及跨页切换均通过 |
| 顶部密度 | [更新前](browser-before.json)状态区高 121.97px，含一个页内大标题；[更新后](browser-after.json)为 13px 字号的单行状态栏，高 20.80px，页内大标题数量为 0 |
| 移动端与主题 | 390px 宽度下状态栏自动换行，高 45.59px，整页宽度仍为 390px；刷新深链、放弃草稿及深色主题通过，无页面错误或失败 HTTP 请求 |

实机截图：[桌面选择器](selector-desktop.png)、[移动端](selector-mobile.png)、[深色状态栏](status-dark.png)。截图中的新增配置是未保存草稿，验证结束已放弃。前后业务配置文件的存在状态与摘要一致，没有新增配置、调用模型或操作业务实例。

首次检查早于平台重载完成，出现连接断开，见[首次失败记录](browser-after-initial.json)。等待新进程的登录页 HTTP 200 后重新执行，最终实机检查通过；未通过放宽检查或修改业务数据规避失败。

本轮保持原 Profile 摘要、数据根及 HOME，构建前备份现有制品，再使用原启动命令和环境重载 3090。程序仍位于 `feat/PLATFORM-gateway-mcp-control` 未提交工作树，没有提交、合并或推送。本轮不提升真实外部提供方、业务风险检测或定时任务闭环的验收结论。

| 运行定位 | 本轮核对结果 |
|---|---|
| 地址 | `http://10.0.160.32:3090/hep/#/gateway` |
| 平台进程 | PID `2004307`，替换原 PID `1969383` |
| 程序根／数据根 | `/home/admin/work/ai-agent-harness` ／ `/home/admin/harness-engineering-platform-data` |
| HOME | 数据根下 `.local/platform-home` |
| 平台日志 | 程序根下 `.local/business-control-acceptance/main-3090.log` |
| 构建日志、备份与装载摘要 | 程序根下 `.local/gateway-selector-ui-20261020/`；`deployment.json` 保存客户端 SHA-256 和配置未变核对结果 |
| 按需停止 | `kill -TERM 2004307` |

上表是本轮部署时的定位。2026-10-20 清理后，构建目录已归档至 `/home/admin/harness-engineering-platform-backups/state-cleanup-20261020-Vl9YYs/gateway-history/gateway-selector-ui-20261020/`，3090 当前日志位于数据根 `.local/logs/main-3090-20261020.log`；表内 PID 不代表当前进程。
