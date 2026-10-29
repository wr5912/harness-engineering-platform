# 原生确认问答接入整改与验证

2026-10-28，关联 `PA-08`、`PA-12`。本次修复程序侧通用 Runtime 接入，不修改业务 Harness、DSH 源码、确认权限或提示词。

## 根因与修复

问题实例为 `emergency-action2`，原会话为 `session-04e40fa3-bdd8-45a6-9eac-600b1d7ed4df`。原生问答的 WebSocket 事件流与独立 HTTP `$events/result` 请求分别创建 Peer；DSH 按对象身份校验回答所属客户端，因此拒绝回答。客户端将回答发送失败视为连接异常，恢复连接后再次收到未完成的问题。旧实现还在页面完成、HTTP 完成和单连接释放时直接销毁 Peer，不能只增加对象缓存而保留这些释放路径。

[修复前回归日志](baseline-failure.log)在真实 DSH TypertGateway、原生 WebSocket mux 和 HTTP 回答路径复现：HTTP 为 `200`，RPC 为 `ok:false`，错误为 `gateway/interactions-forbidden`，消息为 `typert gateway: $events/result: Remote event result belongs to another Peer`。这是隔离测试复现，并非事后取得的原故障抓包。该轮另一项生命周期测试在错误格式化时还出现夹具 `href` 注入错误，不能作为第二项独立根因证据。

修复集中在 [BusinessConnection](../../../src/business-control/runtime.ts)：无需认证的开发实例在同一 Connection 服务内复用一个 owner Peer；每个新请求仍独立验签并保存自己的上下文。API bridge 使用本次 admission 的上下文，避免共享对象承载可变的“当前请求”身份。页面、HTTP、WebSocket 释放统一通过 admission 的 `release`；单个请求或连接结束不销毁共享 Peer。共享模式撤回、来源失效、许可撤回或服务卸载时销毁 Peer，并清理缓存。已认证和已发布实例保留原有非 owner 路径。

调用方、页面完成回调、API bridge 和测试夹具一并更新。当前合同只在[系统架构与部署设计](../../../../../docs/platform-design/02_系统架构与部署设计.md#81-业务网关)维护；本记录保存实施证据。

## 验证结果

| 验证 | 结果及可证明范围 |
| --- | --- |
| 类型检查与构建 | `pnpm run build` 通过；生成的 ESM 用于后续测试与实际装载。 |
| 业务接入回归 | [101/101 通过](business-regression.log)，覆盖业务网关、Runtime、共享/认证访问和既有业务控制路径。 |
| 原生问答定向回归 | [3/3 通过](focused-regression.log)：两个事件流共享身份；HTTP 回答、重复回答只结算一次；页面完成及其他 HTTP 请求不破坏问答；断线恢复只重投未回答问题；取消后的迟到回答不重复结算。 |
| 身份及生命周期 | 同一 Peer 的不同请求上下文独立；缺签名和重放请求拒绝；连接释放不销毁共享 Peer；发布模式、认证模式、来源摘要、实例登记、控制开关变化及卸载均释放旧 Peer。 |
| 原生浏览器提交 | 标准镜像中的真实 `userQuestions.ask`、原生卡片和提交按钮联调通过；[回执](browser-receipt.json)为 HTTP `200`、RPC `ok:true`，服务端仅一个完成结果。提交后观察 2.2 秒，卡片消失，页面只建立一个 WebSocket，无页面异常。 |
| 目标实际装载 | 仅重启 `emergency-action2`；[装载与回读回执](deployment-receipt.json)确认制品摘要、入口 HTTP、真实页面和原会话 API 读取。 |

浏览器测试使用同一标准镜像、独立 HOME、独立工作区和隔离网关；测试插件仅请求“确认测试/取消测试”，不连接模型、不发起业务 MCP 或应急动作。测试卡片提交[之前](before-submit.png)与[之后](after-submit.png)保留截图。回执中的 `counter:4` 是诊断期间累计创建的问题数，`outcomes` 只有本次第 4 个问题的一条回答，不表示业务重复执行。

回归命令在 `platform/plugin/` 执行：

```sh
pnpm run build
HARNESS_DSH_ENTRY=/opt/nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/package.json node --test test/business-*.test.mjs
HARNESS_DSH_ENTRY=/opt/nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/package.json node --test --test-name-pattern='原生问答跨|共享 Peer 不共享|无需认证的开发实例保留' test/business-gateway.test.mjs
```

首次未指定 Runtime 来源时存在依赖解析失败；指定实际安装入口后上述 101 项通过。另一次浏览器刷新/双标签补验在刷新前即因空白测试会话重建、测试问题指向旧会话而超时，未产生有效验收结果；没有把它计为浏览器刷新或双标签通过。这两条恢复路径目前由真实原生协议回归覆盖。

## 生效、会话与恢复边界

目标 DSH 为 `0.2.1-rc.2`，锁定提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；标准镜像 ID 为 `sha256:d90185713372e65b6c49555cf2ca633a3351e7f379c9b792804d8d79c7d4211b`。业务 Runtime 通过只读卷装载程序制品，启动时加载的 ESM 被进程缓存，因此本次需要重启该目标容器，无需重建镜像。

实际制品 `business-runtime.js` 的 SHA-256 为 `295f80b1e34a67bb3991fce1baf52ab41096206acd8a48ee6196896d43de6068`；容器于 `2026-10-29T01:46:49.645735029Z`（本地 10 月 28 日）重新启动。容器 ID、镜像、端口、HOME、来源、运行代次、实例登记文件和业务访问配置保持不变；18120 平台 PID `1113973` 未变。预后快照另观察到 `sec-ops-v024` 已不在 Docker 列表，本次未操作该对象；其余快照中的既有容器启动时间保持一致。

重启前原会话已单独备份至当前数据根的 `.local/backups/native-confirmation-20261029T014334Z/`。原日志 51 行完整保留为前缀，重启收尾追加 `step/end`、`turn/end`、`session/end-seed` 三行；没有新增工具调用，仍止于已有的 `disposition_prepare`，没有 `disposition_execute`。经目标真实页面发起只读 `session/page`，HTTP `200`、RPC `ok:true`，读取 53 条事件记录；日志另有一行存储头。第一次启动握手期间出现短暂拒绝，恢复后真实页面无脚本异常或失败请求。

旧等待轮次已随重启结束，不能把旧弹窗当作已经完成的确认，也不会自动重放业务写入。继续原任务时须先核对已有准备结果与有效期，再由用户发起继续并回答新的确认。未代用户回答原弹窗，未验证真实应急执行效果。

共享源码已修复，新加载的实例使用该实现；本次没有逐一重启其他现有实例，它们可能仍缓存旧模块。已认证和已发布实例的跨请求原生确认行为不在本次共享访问修复的验收范围。若后续发现回归，应先保留当前会话与配置，再恢复该程序制品并只重启受影响实例；这会恢复旧问答缺陷，不能作为长期修复。

隔离探针容器、临时进程和仓库内测试辅助脚本已清理。私有原会话正文、凭据和完整 HOME 未入仓。上述结果是平台接入验证，不提升 Harness Evaluation 或 Research Release 结论。
