# 登录主题与更新提示验证

日期：2026-11-04（America/Los_Angeles）。对应 `PA-12`，范围为当前开发平台的登录、主题和 Codex Connect 更新提示。

## 整改与边界

登录页与工作台共用语义颜色和切换图标。初始主题读取原生 `ui-theme.preference`，`system` 跟随系统。未登录的手动选择仅在当前标签页暂存，刷新及错误登录后保留；通过凭据校验才保存到原生配置，进入工作台后清除临时选择。未操作主题时不覆盖原有偏好。主题写入失败显示可重试错误，不签发登录 Cookie。脚本继续通过精确 SHA256 的 CSP 运行。

现场 Codex Connect 为 `0.2.0-alpha.11`。其全局更新组件在挂载时检查更新；“稍后提醒”仅保存当前版本与新版本的组合，不能阻止后续版本、其他浏览器或清除存储后的提示，现有插件也没有关闭该浮层的配置。

平台通过 DSH 原生插槽的同名贡献替换 `dsh-codex-connect-update`，停止全局自动弹窗；保留后台检查和“设置 → 内置插件 → Codex Connect”中的手动更新、账号及模型入口。未修改外部插件，未增加全局样式遮挡、网络拦截或自动升级。平台插件卸载时原生贡献自动恢复；后续升级 Codex Connect 或 Runtime 时需复核槽位 ID 及优先级合同。当前合同分别维护在[前端规范](../../../../../docs/platform-design/26_前端设计规范与原则.md)和[平台接入合同](../../../../../docs/platform-design/02_系统架构与部署设计.md)。

## 验证

源码基于程序 `a44eb6a6` 的本任务差异；共享工作树同时存在部署、实例、评测和认证 Cookie 的其他任务改动，本次提交按文件及差异块隔离。除现场浏览器核验外，最终候选源码在隔离目录中复验，避免将并行修改当作本次提交的能力。

| 检查 | 结果与证据 |
|---|---|
| TypeScript | `tsc --noEmit` 通过，见 [typecheck.log](typecheck.log) |
| 构建 | 插件及 DSH Web 适配器隔离构建通过，见 [build.log](build.log) |
| 定向回归 | `node --test test/login-page.test.mjs test/navigation.test.mjs test/native-auth.test.mjs`，28/28 通过，见 [tests.log](tests.log) |
| 更新生效 | `platform/dsh-deploy update --json` 返回 unchanged、activation none；此次命令未引起平台重启，见 [update-receipt.json](update-receipt.json)。实际页面确认主题按钮与插槽替换已装载 |
| 登录视觉 | Chrome 148，1440、768、390 宽度，浅深色各一张；无横向溢出，44 × 44 的主题控件可见，表单可操作 |
| 登录与主题 | 错误登录及刷新保留主题，切换不清空表单；成功登录衔接主题并清除临时选择；顶栏浅深色选择保存到服务端；退出后继承原生主题 |
| 更新提示 | 清除“稍后提醒”记录并使用有效原生版本检查缓存后，工作台无全局提示；刷新、关闭设置及全新浏览器上下文仍无提示；设置页仍显示新版本与“检查更新” |

[browser.json](browser.json) 保存浏览器断言，不保存账号密码、Cookie 或账户详情。更新检查结果仅在任务独立浏览器上下文的原生缓存边界构造为 alpha.11 → alpha.12，用于稳定触发实际插件 UI，不能据此声称上游目前最新版本为 alpha.12。截图包括[桌面浅色](login-1440-light.png)、[桌面深色](login-1440-dark.png)、[平板浅色](login-768-light.png)、[平板深色](login-768-dark.png)、[手机浅色](login-390-light.png)、[手机深色](login-390-dark.png)、[工作台浅色](workbench-light.png)、[工作台深色](workbench-dark.png)及[保留的手动更新区](manual-update.png)。

测试执行真实登录 HTTP、Cordis 和原生 SlotCore；主题配置写入失败只在其接口边界构造。验证覆盖错误凭据不改主题、非法主题拒绝、保存失败不签发 Cookie、脚本与 CSP 摘要一致、插件加载顺序和卸载恢复。测试中的 esbuild CJS `import.meta` 提示来自既有工作区解析模块；该路径已有环境根配置，最终测试通过。

浏览器主题测试结束后恢复现场原有 dark 偏好，退出测试登录并释放独立上下文。本轮未更新远端部署、其他 Runtime 或业务实例，未执行插件升级、真实上游版本探测、模型业务调用、Experiment Evaluation 或 Research Release 复现。
