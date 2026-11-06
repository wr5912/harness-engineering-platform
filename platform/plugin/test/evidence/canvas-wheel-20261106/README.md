# 编排画布 Ctrl＋滚轮核验

2026-11-05（UTC 11-06），范围为 PA-12 的 MCP 编排画布交互。隔离构建基线为 `f17be49e`，仅加入本次画布源码与测试修改；未混入并行服务端改动。

画布内按住 Ctrl 滚轮向上放大、向下缩小，复用按钮的 40%–200% 范围，每步 10 个百分点。使用非被动监听阻止浏览器整页缩放；普通滚轮放行，空图卸载监听后可恢复。

## 验证结果

- 隔离工作树执行 `node --test test/mcp-graph-canvas.test.mjs test/mcp-composition-client.test.mjs test/mcp-graph-layout.test.mjs test/mcp-client.test.mjs`，57/57 通过。覆盖缩放边界、按钮状态、切换版本、空图恢复、拖动、键盘移动及编排页面既有行为。
- 隔离工作树 `node build.mjs --out-dir lib` 与 `node node_modules/typescript/bin/tsc --noEmit` 通过；当前开发工作树 `pnpm run check` 通过。
- Chrome/Playwright 登录真实开发平台，读取真实编排与接口，仅拦截客户端资源，装载隔离构建。实际鼠标滚轮配合 Control 键验证 100%→110%→100%、40%/200% 上下限、普通滚轮、网页缩放不变、平移保持、节点拖动及重置、节点选择、全屏进入与退出。页面未报错，未执行编排、发布或删除业务资产。原始回执见 [browser.json](browser.json)，页面见 [desktop.png](desktop.png)。
- 首次 `platform/dsh-deploy update --json` 完成构建后因在途管理会话返回 `busy`，未应用或中断，回执见 [update.json](update.json)。
- 随后用户明确要求重启使最新内容生效，经 `platform/dsh-deploy update --interrupt-sessions --json` 更新成功，回执为 `applied` / `managed-restart`。PID 从 `3761078` 变为 `3923503`，工作区、HOME、监听地址和端口保持；11 个运行容器的 ID、名称与端口未变。回执见 [activation.json](activation.json)。
- 两个原管理会话重启后均可回读，会话保留且接口仍报告 `running`；只保存运行状态与提案状态，不含会话正文。见 [sessions-after-restart.json](sessions-after-restart.json)。本轮未核验其任务连续性或最终业务结果。
- 重启后浏览器直接装载实际平台客户端，未拦截资源或接口，重新核对上述滚轮、缩放边界、平移、节点拖动及全屏路径通过，页面未报错、未写入业务资产。见 [live-browser.json](live-browser.json) 与 [live-desktop.png](live-desktop.png)。

## 验证边界

首次浏览器核验使用隔离客户端资源，后续已在实际平台装载并复验。更新使用当前开发工作树，包含其他正在开发的服务端改动；本轮仅验证工具核对及上述画布交互。未做远端部署、全库回归或业务智能体 Evaluation；不提升 PA-12 整体状态。浏览器探针最初未匹配“全屏”按钮，改为必选断言后重新执行通过，保存的是末次回执。
