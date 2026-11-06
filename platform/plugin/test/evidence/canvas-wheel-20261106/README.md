# 编排画布 Ctrl＋滚轮核验

2026-11-05（UTC 11-06），范围为 PA-12 的 MCP 编排画布交互。隔离构建基线为 `f17be49e`，仅加入本次画布源码与测试修改；未混入并行服务端改动。

画布内按住 Ctrl 滚轮向上放大、向下缩小，复用按钮的 40%–200% 范围，每步 10 个百分点。使用非被动监听阻止浏览器整页缩放；普通滚轮放行，空图卸载监听后可恢复。

## 验证结果

- 隔离工作树执行 `node --test test/mcp-graph-canvas.test.mjs test/mcp-composition-client.test.mjs test/mcp-graph-layout.test.mjs test/mcp-client.test.mjs`，57/57 通过。覆盖缩放边界、按钮状态、切换版本、空图恢复、拖动、键盘移动及编排页面既有行为。
- 隔离工作树 `node build.mjs --out-dir lib` 与 `node node_modules/typescript/bin/tsc --noEmit` 通过；当前开发工作树 `pnpm run check` 通过。
- Chrome/Playwright 登录真实开发平台，读取真实编排与接口，仅拦截客户端资源，装载隔离构建。实际鼠标滚轮配合 Control 键验证 100%→110%→100%、40%/200% 上下限、普通滚轮、网页缩放不变、平移保持、节点拖动及重置、节点选择、全屏进入与退出。页面未报错，未执行编排、发布或删除业务资产。原始回执见 [browser.json](browser.json)，页面见 [desktop.png](desktop.png)。
- `platform/dsh-deploy update --json` 完成构建后返回 `busy`：客户端及并行服务端制品均有待更新内容，当前仍有在途管理会话。未应用文件、未重启或中断会话，回执见 [update.json](update.json)。待平台空闲后仍须通过该工具装载并刷新页面复验。

## 验证边界

浏览器核验使用真实平台与接口、隔离客户端资源，不能视为主平台已加载此功能。未做远端部署、全库回归或业务智能体 Evaluation；不提升 PA-12 整体状态。浏览器探针最初未匹配“全屏”按钮，改为必选断言后重新执行通过，保存的是末次回执。
