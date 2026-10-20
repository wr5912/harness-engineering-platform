# 统一网关分类整改：源码、隔离预览与 3090 生效验证

日期：2026-10-20。基于 `feat/PLATFORM-gateway-mcp-control` 的现有未提交实现进行局部整改，保留其他任务的修改。整改顺序与职责边界只在[插件规范](../../../../../docs/platform-design/20_业务访问与运行控制插件开发规范.md#分类整改顺序与完成条件2026-10-20)维护，本记录保存本次执行结果。

管理页与业务入口改为“智能体身份、风险评估、访问控制”。身份内合并凭据验证、可信来源与撤销状态，既有持久字段和拒绝条件保留。MCP 工作区只保留四个工具页签；统一网关继续由顶部一级菜单进入。

| 验证 | 结果与证据 |
|---|---|
| TypeScript | `platform/plugin` 下执行 `pnpm run check` 通过，实际命令为 `tsc --noEmit` |
| 控制核心、管理接口与导航 | `node --test test/business-control-core.test.mjs test/business-control-management.test.mjs test/navigation.test.mjs`：47 项通过，见[日志](core-management-navigation.log)；包括配置保存回读、身份撤销、风险未知、冲突保留草稿、顶部网关入口及 MCP 无重复按钮 |
| 网关与 Runtime 接缝 | 将当前核心、Runtime 与网关源码临时构建到仓库外，复制现有 `business-gateway.test.mjs` 后执行：16 项通过，见[日志](gateway.log)；保留身份失败拒绝、跨用户归属、输出转义、HTTP 同步与下载前复核检查 |
| 隔离浏览器预览 | 使用当前 TSX、平台主题及业务门户渲染源码，Playwright 检查通过，见[浏览器记录](browser-preview.json)；1440px 身份内双分区，390px 单列，均无整页横向溢出、无页面错误，三类切换保留同一草稿 |

截图均使用测试数据，页面注明隔离预览：

- [管理页桌面](management-desktop.png)
- [管理页移动端](management-mobile.png)
- [业务门户](business-portal.png)

该隔离阶段的临时构建与浏览器脚本位于 `/tmp/gateway-classification-20261020-0fad3x5c/`，只供本次本机验证。预览不连接真实管理接口，保存请求不会写入任何服务。该阶段没有构建共享 `platform/plugin/lib`、更新 3090 运行制品或重启平台及业务实例；不能据此声称运行页面已经生效、真实身份提供方通过、定时任务已受检测或业务效果改善。2026-10-19 的实机验收与四项界面截图仍作为历史记录保留。

## 3090 实际生效验证

用户随后明确要求最新修改在 3090 生效。2026-10-20 在 `platform/plugin` 执行 `pnpm run build`，类型检查与构建通过；先备份现有平台及 Web 适配器制品，再使用原命令、环境、数据根和 HOME 重载 3090。Profile 摘要保持一致，没有重建数据工作区的业务扩展或操作业务容器。当前平台仍无业务网关配置，实际页面如实显示关闭、零实例和尚无评估。

使用原管理账号登录实际 [3090 页面](http://10.0.160.32:3090/hep/#/gateway)，浏览器确认：三类功能入口、身份内凭据与来源分区、MCP 第五个按钮消失及顶部网关入口可用；页签、跨页草稿保留及放弃恢复、刷新深链、深色主题与 1440px／390px 布局通过。页面错误和失败 HTTP 请求均为零。只编辑并放弃浏览器草稿，没有保存业务配置、调用模型或执行业务任务。

实机证据与隔离预览分开保存：[浏览器记录](browser-live.json)、[桌面](live-desktop.png)、[移动端](live-mobile.png)、[深色主题](live-dark.png)。本轮只提升管理界面实际装载证据，不提升真实外部提供方、定时任务闭环或 Harness 效果结论。

| 运行定位 | 2026-10-20 核对结果 |
|---|---|
| 地址 | `http://10.0.160.32:3090/hep/#/gateway` |
| 平台进程 | PID `1969383`，替换原 PID `1882073` |
| 程序根／数据根 | `/home/admin/work/ai-agent-harness` ／ `/home/admin/harness-engineering-platform-data` |
| HOME | 数据根下 `.local/platform-home` |
| 平台日志 | 程序根下 `.local/business-control-acceptance/main-3090.log` |
| 构建、制品备份与装载摘要 | 程序根下 `.local/gateway-ui-live-20261020/`；`deployment.json` 保存实际客户端 SHA-256 |
| 按需停止 | `kill -TERM 1969383` |

同日后续重新部署了[智能体选择器与紧凑状态栏](../gateway-selector-ui-20261020/README.md)，最新运行进程与停止方式以该记录为准；本表保留分类整改部署时的定位。
