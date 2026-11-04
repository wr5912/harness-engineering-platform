# 受控 Git 读取恢复核验

本次修复平台的来源清点、源码过滤和依赖失败说明，验收路径为 `PA-12`。通过原管理助手完成实际工具调用，不将源码可读认定为插件已经安装。

## 对象与环境

- 原管理会话：`session-6f7b27d3-86bf-47c7-9bd2-2e5664a6236d`，页面 `/hep/#/conversations`。
- 目标版本：`EXP-security-operations-expert-027-reab20c48f610`。
- 来源：[dsh-decision-engine 固定提交](https://github.com/zuosus/dsh-decision-engine/tree/146453d1427e2cf27d02cc786f3baff78bf87c6c)，版本 `1.1.0`。
- 开发核验日期：2026-11-03（America/Los_Angeles）；以下时间使用 UTC，日期为 2026-11-04。
- 实际平台使用 DSH `0.2.1-rc.5`，锁定 Runtime 提交 `b830ec950faba0a46dda564be3e2d854afed94f1`。依赖准备目标为 `linux/amd64`、镜像 `ai-agent-harness/dsh:b830ec950-amd64-2ed0d15ad02e`。
- 代码修复起点为程序 `58ee3ce` 的工作树；提交隔离工作树基于远端 `6046b430e5e162518b0f1cabb27722272878e6b2`，仅移入本次六个源码与测试文件及本文、截图和验收索引。原工作区及数据仓库的并行修改保留。

## 根因与修复

原实现使用 `git clone --bare --filter=blob:none`，随后执行需要文件大小的 `git ls-tree -r -l -z`。缺失的 blob 导致 Git 逐项联网补取，清点在 60 秒超时后被统一包装为 `migration_failed`。原会话两次失败调用分别耗时 64.745 秒、62.408 秒。

对同一固定来源的只读复现中，部分克隆约 1.9 秒完成，但清点在 60.005 秒被终止；完整克隆约 2.1 秒，清点仅 59 毫秒。Git trace 中，部分克隆产生 50 次补取子进程，完整克隆没有补取。现改为一次取得完整对象，保留固定提交、禁止 Hook、读取上限和取消语义。失败回执区分克隆、解析提交、文件清单和文件正文，并说明超时或输出超限。

恢复 Git 清点后还发现两个直接阻塞完整源码的误判：`lib/credentials.js` 被文件名规则当作凭据文件；`lib/client.js` 中包含 API Key 名称的界面说明被当作凭据赋值。共享过滤现在允许凭据处理代码接受正文检查，字段匹配要求完整字段名。`.env`、凭据配置、实际凭据常量及 LLM Key 的原有过滤继续生效。

依赖执行器原先把进程被终止一律显示为退出码 `unknown`。现分别报告超时秒数、输出超过 4 MiB、终止信号和真实退出码，继续不返回安装器原始输出。本次没有复现或断言已经解决原先 Docker 超时的外部原因。

## 原管理助手实际验收

第一轮清点与入口读取在 06:21–06:27 完成，工具结果保存在原 Session 中：

- `migrations/inspect`（事件 794–795）耗时 **11.531 秒**，返回固定提交的 70 项清单；来源为 `source-a5be24fa-f725-4123-bc95-da431683534a`。
- `package.json` 读取成功；`lib/index.js` 经五次连续分页读至末尾，偏移为 0、24000、48000、72000、96000，最后 `next_offset:null`。所有分页来源摘要一致且未脱敏。
- `assets/dependencies/prepare`（事件 843–846）实际进入依赖声明核对，返回 `dependency_pending`：现有 voice-hub 将 DSH 公共模块列为直接或开发依赖，应改用目标 Runtime 的共享 `peerDependencies`，不能安装第二份 DSH/Cordis。该失败不是 Git 读取失败，没有记录为准备成功。

源码过滤修复后，原管理助手在 06:35–06:38 再次执行完整清点和读取：

- `migrations/inspect`（事件 889–890）耗时 **10.583 秒**，来源为 `source-80c0b333-fb0b-4a11-a36f-883c06c4ce6b`，固定提交正确。
- 指纹为 `1f62a06b2a511693b3732dd133dde1c7005ea8dce2f3b17d5de7a83d7c2e73bc`。
- `lib/client.js` 和 `lib/credentials.js`（事件 902–905）均使用 `limit=131072` 一次读完，返回 `truncated:false`、`next_offset:null`、`redacted:false`，文件摘要等于正文摘要。

| 文件 | 原始字节数 | SHA-256 |
|---|---:|---|
| `package.json` | 2553 | `0003ef17038bf09cd1c72429fc216c5102474031e73578badc3de229b1981873` |
| `lib/index.js` | 131999 | `30b3501bbb5217430d883c8f02a8254072559f4b7fefed7329a07f3b099860ed` |
| `lib/client.js` | 160354 | `24861ab7cbe7b0c6cd1f95ad48ce6cb12906a8650e807ff8b6aa23a98663b96b` |
| `lib/credentials.js` | 6438 | `22ea07ef1e1d4892e1dd10a19fafaf5f1f86585caf8f4f3ce7de812bf4330499` |

管理助手在事件 914 明确回复清点与读取验收通过，事件 917 正常结束本轮；[实际页面截图](assistant-acceptance.png)展示新来源及两个文件的完整读取回执。

新清单仍排除九个测试文件，原因为“包含凭据常量，未保存原文”：`cache-regression`、`client-ui`、`config-file`、`config-rename`、`credentials`、`outcomes`、`providers`、`save-path`、`stats` 对应的 `test/*.test.js`。未读取这些排除项，也不以过滤判断断言其中一定含真实密钥；未声称保存了整个仓库的逐字节副本。

## 生效与自动验证

通过 DSH 原生 `pluginManager/setBundleEnabled` 重载已启用插件，最终回执时间为 06:41:19.368，`application:applied`、`warnings:[]`。装载前没有运行中的独立部署导出任务，平台 PID 始终为 `1355770`，启动时间保持 2026-11-03 20:13:57（本地时间）。没有重启平台或业务实例。

- `pnpm run build`：类型检查与构建通过。
- `node --test test/migrations.test.mjs test/version-source.test.mjs test/asset-build-dependencies.test.mjs`：52/52 通过。真实 Git HTTP fixture 断言清点及正文只使用一次 pack 取回，并检查失败阶段；子进程测试覆盖超时、输出超限、信号、退出码及私有输出不回传；正文与路径回归覆盖误判和实际凭据过滤。
- 隔离工作树的 `pnpm run test:business-access`：平台 195/195、TypeScript 适配器 21/21 通过，包含类型检查与构建。
- `git diff --check` 通过；只保留必要源码、测试、验收记录和截图。

本次证明平台受控 Git 清点与必需源码读取恢复，并改进依赖失败反馈。既有 voice-hub 依赖冲突仍待处理；未执行来源代码、安装决策引擎、修改业务运行配置或重启实例。未完成插件装载、真实决策调用、Experiment Evaluation、Research Release 或全库回归验收。
