# 版本装载与源码编辑验收

验收时间：2026-10-28（UTC 2026-10-29）。关联 `PA-03/04/05/06/10/12`，结论仅覆盖平台与工具合同。

## 实际平台

入口为 `http://172.16.138.228:18120/hep/`，程序根为 `/home/cmp/work/harness-engineering-platform`，数据根为 `/home/cmp/harness-engineering-platform-data`。版本身份和装载规则见[存储合同](../../../../../docs/platform-design/03_存储架构与数据契约.md#版本身份与装载声明)。

- [接口回执](live-after.json)：13 个版本解析成功，无版本错误；EXP025 桥接源码可编辑，原文、源码摘要与正文摘要一致，`${options.token}` 保持原文。201 条管理会话及问题会话 `session-e3c748eb-15f5-4388-877d-91e0251e7702` 保留；6 个运行中业务实例的容器 ID 和端口均与操作前一致。
- [浏览器回执](browser-acceptance.json)：登录实际平台，在 EXP025 的 Harness 资产中选择 `mcp-group-bridge.ts`，编辑器原文与磁盘一致；预览通过，点击应用保存后显示成功。保存使用未改动的正文，核对文件字节和 SHA-256 均未变化，页面无脚本异常。[预览画面](asset-editor.png)与[保存后资产页面](asset-saved.png)保留。
- [固定父版回执](exact-parent.json)：在独立临时 Git 工作区，使用原问题提交 `c5d0a2f2904233cd61e42d5796892fcd00311261` 和 EXP025 创建派生版本；桥接文件与该提交逐字节一致，当前来源登记表不存在。回执中的新版本只存在于临时工作区，没有写入实际数据根。

服务端模块需要重新装载，因此核对无在途管理任务后重启一次平台；业务实例没有重启。宿主 I/O 等待使启动超过生命周期命令的 60 秒等待窗口，命令返回超时后保留进程，随后监听、原生登录、RPC 和页面全部通过。后续前端保存反馈修复通过构建、页面刷新生效，没有再次重启。

## 确定性检查

| 检查 | 结果 |
|---|---|
| 插件类型检查、构建和离线 prepare | 通过 |
| 插件全量测试 | 844 项：842 通过、1 跳过、1 失败；失败项为本机 MCP 协商 `ECONNRESET`，该文件独立重跑 2 项通过。跳过项要求 root，当前未执行 |
| 最终版本来源与智能体接口回归 | 54 项通过 |
| 最终智能体页面回归 | 37 项通过，包含保存期间实时刷新不丢弃成功回执 |
| 助手与资产源码往返定向检查 | 3 项通过，包含变量引用、错误语法、只读脱敏和双摘要 |
| Python 来源解析 | 25 项通过 |
| Python dsh-dev | 146 项通过 |
| 部署数据依赖定向检查 | 1 项通过 |
| 显式完整数据仓库校验 | `valid: true`，无错误、无警告 |
| 两仓 diff 空白检查 | 通过 |

测试入口为 `platform/plugin/test/{version-source,agents,agents-client,assistant-business-assets,agent-assets,business-group-v2}.test.mjs`、`runtime/adapters/dsh-container/test_source_contract.py`、`test_dsh_dev.py` 和 `platform/deploy/test/data-dependencies.test.mjs`；全量插件测试使用锁定全局 DSH 入口，设置 `HARNESS_DSH_ENTRY` 后执行 `node --test --test-concurrency=2 test/*.test.mjs`。显式完整校验入口为 `runtime/research/validate_repository.py`。原始过程日志保留在本机 `/tmp/hep-source-simplification-20261029/`，不复制资产正文、会话原始事件或凭据到验收资料。

浏览器初次保存已写入文件，但实时目录刷新使客户端丢弃了同一文件的成功回执；新增竞态回归并修正后，实际页面保存通过。全量测试的首次失败保留为失败，不表述为一次全量通过。

提交前在独立程序工作树和数据工作树核对发布内容：插件构建通过；关联回归覆盖 268 项，受影响两文件最终复测 117 项通过，其余 151 项通过；来源与业务启动 Python 35 项、dsh-dev 146 项、部署依赖 1 项通过。数据侧 12 个已跟踪版本全部完成装载解析；实际工作区另有尚未纳入本次提交的研究草稿。两仓暂存内容通过空白和 LLM Key 常量检查。

合入并行平台提交后再次核对最终组合：插件类型检查与构建通过，相关插件回归 243 项、管理技能装载 4 项、来源解析与启动器 Python 183 项全部通过。

## 边界

本次没有改写 EXP025 业务源码、执行新的模型业务任务、创建实际业务版本或新增 Experiment Evaluation Run；没有验证 Research Release 复现。历史 Run、用户草稿和并行改动保留。13 份装载声明及管理技能在正确数据根迁移，当前登记表已移除，历史 Git 中的登记内容仍可按固定提交读取。验收时尚未提交或推送。
