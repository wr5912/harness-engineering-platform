# 管理助手 Playwright 页面核验

核验时间：2026-11-11 UTC。对应 `PA-08/12`，范围为管理助手的浏览器工具、原生图片上下文及本机实际装载。

程序来源为 `3cdb8db34fb634116395025e25af68f1bd131d9c` 加本提交差异；验收时工作树包含本次未提交修改。锁定 DSH 为 `0.2.1-rc.5`，浏览器使用标准镜像 `ai-agent-harness/dsh:b830ec950-amd64-2ed0d15ad02e`。本次未修改 DSH 源码、业务 Harness 或数据仓库的可维护资产。

## 工程验证

在 `platform/plugin/` 执行以下检查，类型检查及 98 项测试全部通过，无跳过：

```sh
pnpm run check
HEP_BROWSER_TEST_IMAGE=ai-agent-harness/dsh:b830ec950-amd64-2ed0d15ad02e node --test test/assistant-browser.test.mjs test/assistant.test.mjs test/assistant-documents.test.mjs
```

[浏览器测试](../../assistant-browser.test.mjs)经过真实 Docker 浏览器和本地认证 HTTP 边界，覆盖登录、填写、按键、点击、等待、全页与元素截图、超时失败。两种中文字符的元素截图必须不同，避免缺字方框被误认成正常中文。操作摘要隐藏填写值；追踪元数据不含登录 Cookie。驱动语法检查与差异空白检查通过。

平台认证使用现有账号建立原生 Cookie，经标准输入交给浏览器；先确认进入平台界面，再执行动作。浏览器只读挂载宿主机字体，截图沿用 DSH 原生附件存储和后续图片上下文。合同见[管理助手页面核验](../../../../../docs/platform-design/02_系统架构与部署设计.md#管理助手页面核验)。

## 原生管理助手端到端验证

在本机 `172.16.138.228:18120/hep/` 创建四个新的原生 `standard` 会话，逐个显式选择 `deepseek-official / deepseek-flash / max`。核对选模回执及每次实际模型请求的配置一致；每个会话只调用一次 `platform_browser`，最终均正常结束。

| 用例与真实会话 | 操作与结果 | 图像证据 |
| --- | --- | --- |
| 页面操作：`session-822a60bc-9dd8-4a7d-a155-5e171bcf460f` | 智能体页填写搜索条件、按 Tab、点击实例管理，等待说明出现，对实例名称使用精确文本定位按 Tab；工具成功，助手确认列表已加载、当前有 4 个运行实例。 | [平台实例页](platform-actions.png) |
| 元素截图：`session-f4c4ca98-30d3-4613-9d4b-f9273ec3d6a3` | 首页按 heading 和精确名称定位；工具成功，助手确认截图只有目标标题、无乱码和遮挡，并限定结论到该元素。 | [首页标题](platform-element.png) |
| 实例截图：`session-847a0d40-8558-4d7d-be24-8ae4e6b90033` | 经已登记实例 `inspection-027-schedule-acceptance` 的真实统一网关入口，等待“智能对话”后截取视口；工具成功，助手读出实际应用、概览及推荐卡片，研发回看确认中文正常。 | [实例页面](instance-viewport.png) |
| 预期超时：`session-3119732e-dc90-486c-8171-0ab80785b9d7` | 首页等待刻意不存在的文本，10 秒后返回 `state=failed / stage=action / browser_action`；助手准确说明原因、没有截图且未重试。负向验收通过，页面检查本身保持失败。 | 无成功截图 |

三次成功结果均核对原生 `user/message` 图片事件，导出图片的 SHA-256 与工具返回的原生附件 ID 一致；助手随后完成图片回看。对应追踪的网络文件为空，不保存请求头。模型没有执行其他工具或发送业务消息。

本地原始回执和会话事件位于程序根 `.local/browser-acceptance-20261111/`；各次检查证据位于数据根 `.local/browser-inspections/`，目录 ID 依次为 `28b8e1bc-dff4-45e1-99d8-662b241aa9d1`、`623e15cc-1f60-48d9-8727-a8fc4b3620d3`、`3527ca36-e0f4-45a7-b953-5553b5c36636`、`65ba5dda-8a48-45dd-921e-186d3a2596dd`。原始会话与追踪不纳入 Git；本目录保存已回看的截图。

## 本机生效与边界

通过 `platform/dsh-deploy update --interrupt-sessions` 更新，回执为 `applied / managed-restart`，PID 为 `1062411`，工作区仍为 `workspace-95db14d2-d53d-4015-8256-ade8612b1b77`。更新使用此前允许中断管理会话的授权，保留会话历史与业务实例；部署回执位于程序根 `.local/platform-updates/f84b4249-33eb-43f0-aba6-3ea029da19cb/receipt.json`。上述四项验证均在此次更新后的新会话完成，运行状态复查为 `running`。

此前 GPT overload、登录页误入、中文缺字、等待超时时间过短和模糊文本命中两处的记录均保留在本地，不作为通过证据。最终验收固定使用用户指定的 DeepSeek 模型，登录与中文问题由共享实现修正，歧义定位改用精确定位。

`full_page` 使用 Playwright 原生全页截图；平台内部滚动区域仍按可见范围呈现。本次平台截图为 1280×720，底部列表未完整展示，助手明确指出这一限制。截图、快照及追踪可能包含输入内容和页面可见数据；不据此声称自动脱敏全部内容。

本次未发送实例业务消息、运行完整业务 Evaluation、验证需登录实例的业务凭据或同步远端部署；未重跑全仓测试。不提升业务 Evaluation、Research Release 或一级路径整体结论。
