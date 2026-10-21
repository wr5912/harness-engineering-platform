# 统一网关与 MCP 即时任务控制证据

这是 2026-10-19 在开发分支完成的项目与工具链验收证据。范围、固定来源、实施结果与限制唯一记录于[实施验收](../../../../../docs/platform-design/21_统一网关与MCP控制实施验收.md)，接口唯一维护于[插件规范](../../../../../docs/platform-design/20_业务访问与运行控制插件开发规范.md)。

## 当前界面

| 证据 | 证明的事实 |
|---|---|
| [3090 浏览器检查](browser-main-3090.json) | 原账号、一级统一网关、真实空状态、深链与刷新、四项切换、跨页与轮询草稿保留、1440px／390px 无页面横溢出 |
| [3090 桌面](main-3090-desktop.png)、[窄屏](main-3090-mobile.png) | 顶部状态概览、桌面配置／运行双栏、四功能切换、窄屏适配；不是全表单直接堆叠 |
| [联调配置浏览器检查](browser-management-final.json) | 固定业务的真实状态与四功能配置可读，当前配置与事实数量从管理接口返回；HTTP 投影摘要不含凭据 |
| [联调桌面](management-final-desktop.png)、[窄屏](management-final-mobile.png) | 已接入实例的页面布局；这是独立验收数据，不是 3090 已开放业务的声明 |
| [业务入口 A](gateway-subject-a.png)、[B](gateway-subject-b.png)、[窄屏](gateway-mobile.png) | 用户各自可见的智能体四项状态与入口；登录身份不替代 Agent 认证和信任 |
| [真实运行控制](runtime-control.json) | 固定来源、双用户、真实模型巡检、范围化风险与报告下载的精简事实；每项以自身状态为准 |
| [原生业务最终检查](browser-native-final.json)与[桌面](business-native-desktop.png) | 固定工作区、本人历史、编辑器发送只读消息、真实模型与上游计数，以及首次确认等待和跨用户拒绝；辅助接口的范围限制仍保留 |
| [验证结果](verification.json) | 最终平台 586 项、启动器 132 项、渲染 4 项、Web 13 项和 Mock 149 项的检查边界 |

`browser-main-3090.json` 与 `browser-management-final.json` 对管理 HTTP 响应只保留数量及开关摘要；原始响应原保存在本机 `.local/business-control-acceptance/`，现已归档至 `/home/admin/harness-engineering-platform-backups/state-cleanup-20261020-Vl9YYs/business-control-acceptance/`。刷新、切页时观察到的原生 Cordis 检查请求取消保留在 console 记录，不作为业务成功或失败的替代证据。

## 早期观察与失败

[初版浏览器记录](browser-readonly.json)、`management-desktop.png`、`management-mobile.png` 是改版前的纵向表单及业务入口检查，仅用于保留初始事实，不能作为当前布局。

[原生启动失败](browser-native-initial.json)及 `business-native-desktop-initial.png` 记录缺少原生浏览器连接模块时的 `Failed to load plugins`。其中 `ready: true` 仅代表出现非空 DOM，实际启动失败。初期空白页面、冷启动／重启期间的 503、会话创建依赖缺失和风险请求合同错误的原始探针也保存在本机；修复后另行复验，不覆盖成成功结论。

[冷加载失败](browser-native-cold-failure.json)保留同步 AST 转换阻塞控制心跳时的空白与 503；它不代表最终 Worker 修复后的状态。

`business-native-mobile.png` 是早期加载观察，不作为最终业务手机交互通过的证据；本轮最终窄屏布局验收使用上表 3090、联调管理页和业务门户截图。

## 验证日志

上述本机归档保存平台全量测试、启动器、业务渲染、Web 适配器、模型 Session、风险收紧／恢复、报告下载及目标账本。外部提供方与业务目标使用 Mock；真实企业身份服务、实际设备处置、定时任务、全部业务子 Agent 及生产部署不在本次证明范围。凭据与模型 Key 位于本地忽略文件，不入此证据目录。
