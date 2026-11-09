# 故障排查迁移验收

本目录保存两类原生 LFX 故障编排及指定 EXP027 实例的技术和浏览器证据，关联 PA-03、05、06、07、08、12。业务资产、评测及研究结论以数据工作区的 `agents/security-operations-expert/docs/troubleshooting-candidate-integration-20261107.md` 为入口。

- [合同、报告与接入回归](technical-checks.json)：最终报告400/400、组合合同56/56、业务接入平台204/204及容器23/23通过。既有威胁子会话断言28/29保留失败，不归入故障迁移通过范围。
- [官方 LFX 执行](native-lfx-controlled.json)：正式 flow/TS，仅模拟外部 SOC；两根流程通过。与[公开 dry](public-dry.json)均不能替代真实 SOC 业务验收。
- [实际控制流画布](graph-browser.json)：条件标签、批次与嵌套展开、返回均完成，无页面异常。
- [业务访问报告](access-browser.json)和[设备不在线报告](offline-browser.json)：实际原生会话预览、两次下载通过，原字节摘要相符，没有页面异常。
- [真实异步排查 Run](real-async-runs.json)：保留两个错误IP输入及两个更正输入的真实结果；更正后的两类流程执行完成、各8项事实并生成HTML，业务均为 incomplete。资产身份、管理响应、路径、端口及流量证据缺口按各自 Run 保留，没有主动探测或设备写入。
- [异步报告复用](async-access-repeat-fixed-after.json)与[离线复用](async-offline-repeat-fixed-after.json)：修复首次导出之前的轮询被误判为新来源；保留失败前证据。两原会话各仅导出原附件，新增 SOC/诊断调用为零。[业务访问浏览器](async-access-browser.json)及[离线浏览器](async-offline-browser.json)均完成预览、两次下载，原 HTML 摘要一致、页面异常为零。
- [节点事实持久化与公开读回](persisted-facts-readback.json)：运行中已完成节点的事实可见，公开读取摘要与已保存事实一致。
- [当前实例装载](instance-final.json)及[草稿绑定](binding-final.json)：重载后为 current/verified，差异为空，两草稿按业务来源摘要绑定。
- [隔离程序验证](selected-program-checks.json)与[隔离数据验证](selected-data-checks.json)：仅叠加本次提交内容，排除并行任务；构建、业务接入22/22、MCP覆盖2/2、报告400/400及合同56/56通过。
- [受管构建](report-build-final.json)及[平台更新](platform-update-final.json)：源码构建、平台激活与实例实际装载分别核对。

[迁移前 Run](baseline.json)和[基线浏览器](baseline-browser.json)、巡检与 legacy 报告证据只证明各自冻结来源。[并行来源变化记录](evaluation-concurrent-source-change.json)保留 run-99282789-7ff3-435e-b6dd-403eb12b9caf 的真实失败：另一任务更新并重载同一 Candidate，使该轮来源不一致。稳定来源后保留历史 run-ea5f30b0-19ac-408e-b72d-4beabb28d4c1 的四项完成、一项错误结果，并通过管理助手完成五项独立最终 Evaluation；详见 [最终验收结果](final-evaluation-20261109.json)。五项 Run 均 `source_verification=matched`：U-FLT-012 因 `evaluation-interrupted` 被取消并判为 inconclusive，U-FLT-016 执行错误并判为 inconclusive，U-FLT-017、U-INS-024、U-QA-016 完成且通过。整体 Decision 仍为 `continue`，两项真实失败不被覆盖为通过。实例证据在验收时读取为 current/verified；随后并行任务继续修改同一 Candidate，最新读取已变为 `pending_reload`，早先回执不代表当前装载状态。
