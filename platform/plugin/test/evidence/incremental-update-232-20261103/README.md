# 232 双仓增量更新与 EXP027 续验

本次对应 `PA-05/08/10/13`。程序和数据通过 `platform/dsh-deploy update` 增量交付；随后只将指定 EXP027 的异常诊断资产通过 `agent-update` 定向交付。外部巡检服务仍由用户整改，本次不判为巡检业务通过。

## 双仓交付与生效

| 对象 | 更新前 | 更新后 |
|---|---|---|
| 程序 | `6771136d8f0f83a6ade48f3a33772278d0006e11` | `ea509f21c10472ea819d55a51b08adacc266fe00` |
| 数据 | `81e2d43650b54d78fc6a9d5175a3b8ad9fa55400` | `2c2786edd4eefae434249482cedd4c39b9ff1ea4` |

现场程序根为 `/srv/storage/hep-rc5-20261102/program`，数据根为 `/root/harness-engineering-platform-data`。数据仍位于原磁盘的持久 bind 挂载，不复制第二份工作区。

先执行 `--dry-run`，再执行同一命令去掉该标志：

```bash
platform/dsh-deploy update --ssh root@172.16.138.232 \
  --prefix /srv/storage/hep-rc5-20261102/program \
  --remote-data-root /root/harness-engineering-platform-data \
  --data-root /home/cmp/harness-engineering-platform-data --dry-run
```

[更新回执](applied.json)记录 286 个实际变化文件，文件内容 48,826,956 字节，压缩增量包 55,594,898 字节；包内包含 Git 增量对象及文件，SSH 传输还存在编码开销。没有重新传输镜像、依赖和会话。双仓更新只取已提交 HEAD，现场未提交配置和无关改动保留。

工具复用安装器 Node 和现有离线依赖构建隔离 HEAD；检查冲突、Git 定位与安装清单，保留普通文件 inode 以适配单文件 bind 挂载。历史 prepare 生成但未列入旧清单的制品按实际摘要纳入备份；原清单已登记的制品仍须匹配摘要。失败恢复文件、清单及 Git 定位，不静默回退全量部署。维护入口及边界见[打包安装合同](../../../../../docs/platform-design/23_离线一键打包与安装.md#已安装双仓的增量更新)。

服务端已加载代码不能只靠新 Session 替换，核对管理会话无运行中任务后，通过维护的 `dsh-platform` 入口定向恢复平台。首次页面首帧与在线工作区检查分别超时，原因未查实，未再次重启；后续[安装及在线检查 9/9 通过](verify.log)，平台 PID 为 `909528`，工作区、21 个技能、登录、inventory RPC、网关及两个业务入口均核对通过。

## 指定 EXP027 实际巡检

目标固定为 `EXP-security-operations-expert-027-reab20c48f610` 和实例 `security-operations-expert-exp027`，没有切换到其他版本。

实际业务 Session `session-9672a86a-3377-4ac0-bfd9-e98d81c3fa72` 的两轮身份问答没有暴露 DSH、容器等内部环境。第三轮“执行一次常规巡检”同轮完成真实目录查询、`prepare_inspection` 和 `start_inspection`，没有要求再次确认。省略设备选择器后，服务端解析任务默认范围为全部纳管设备 63 台；客户端没有代填 ALL。

| 启动定位 | 实际值 |
|---|---|
| MCP 入口 | `http://172.16.138.228:26000/mcp/inspection` |
| MCP 方法 / 工具 | `tools/call` / `start_inspection` |
| DSH 工具名 | `mcp__inspection__start_inspection` |
| taskId / definitionVersion | `task-73aa54d940fb4b94bbb364a7ca7829d0` / `V9` |
| preparationId | `prep-445cc521-aea2-4727-8eef-30a24ed504ab`，READY |
| requestId | `f486dfb7-83f9-48da-a232-5cf2f74acbf3`，运行插件绑定 |

启动调用抛出异常，未取得 runId。此前适配器只保存了已尝试状态，没有保留异常原因；DSH 原生 MCP 客户端可能将错误回执抛为异常，因此现有证据不能区分业务拒绝、协议或网络异常，也不能判断服务端是否受理。原请求保持未知，不重新准备或启动。当前服务没有按 requestId 查询的工具；用户已确认服务端继续整改，等待其通知后再验证。

业务证据唯一保存在数据仓库 `evolution/experiments/EXP-security-operations-expert-027-reab20c48f610/runs/run-494de6bf-305d-4197-8fc0-8969e914db9b/`：两项 Case 执行完成，身份项通过、巡检项失败，整体 `failed`；五项来源摘要核对一致。本轮未提交推送该 Run。

## 异常诊断交付与恢复核对

只修改目标 EXP027 的 managed TypeScript：DSH 抛出的异常只将 name、message 和可选 code 保存在原生 HOME 的私有账本，不向用户、模型或普通日志暴露底层内容，不保存整个异常对象、headers 或 stack；未知请求仍阻止重复启动。按既有资产构建入口生成 ESM 和构建回执，[构建来源核验通过](diagnostics-build.json)。

通过 `dsh-deploy agent-update` 先预检后交付源码、ESM、`change.yaml` 三个文件，共 39,219 字节，[回执](diagnostics-applied.json)保留原 SHA 与备份位置。未构建派生镜像。

核对在途任务为零后，在原生实例管理界面预览并仅重启目标实例，回执为成功 1、失败 0。此操作按既有生命周期重建目标容器及其 HOME 初始化容器；不是原容器 ID 不变。目标标准镜像保持 `sha256:c06d4e1fecc66f175a2fbeaa51e96ea0b2af8f58be22f89edac73df3c779bece`，实际只读挂载的 ESM 摘要与构建结果一致，见[文件及入口核对](final-check.json)。

[最终状态比较](final-state.json)确认：

- 68 个容器对象，受保护 `hep-deploy-accept-amd64-final` 的 ID、启动时间和镜像均不变。目标和其 HOME 初始化容器按上述原生操作重建；另一个既有重启循环的 `/kb-access-helper` 启动时间变化，本次未操作它。
- 原有 9 个管理 Session ID 保留，`workspace.json` 和默认模型配置摘要不变。双仓增量更新阶段三项现场配置均不变；原生重启目标后 `business-access.json` 摘要变化，未声称生命周期运行登记保持逐字节不变。
- 原问题会话的未知请求账本摘要仍为 `a69ffa45f986f19009d3314f170e7b8f59fd2f03223ae422ee19f7032db84475`，没有清空或重放旧请求。
- 18120、目标及受保护实例入口均返回 HTML 200；这只证明入口响应。目标新 Session `session-7d96f550-f786-4b37-8961-59f17c6efd02` 的“你好”已完成，实际[页面截图](diagnostics-smoke.png)核对业务身份正常。

## 测试与边界

- [部署相关测试](deploy-tests.log) 15/15，通过实际临时 Git 仓库验证增量推进、无关修改保留、冲突停止和失败恢复。
- [EXP024–027 与指定 EXP027 回归](diagnostics-target-tests.log) 19/19，包括异常字段最小留存、0600/0700 权限、恢复后禁止重复启动；外部异常分支使用测试夹具。
- [巡检运行时完整测试文件](diagnostics-tests.log) 38/39；未修改的并行 `VAR-security-operations-expert-001-rd4c625231cdb` LangGraph 测试失败，不能报告完整回归全通过。

原生异常内容从旧调用中无法追溯恢复，新诊断分支尚未通过真实服务异常再次触发；最后一次重启后的验证仅为普通问候，不覆盖真实巡检。未验证 runId、巡检结果、报告交付和 Research Release；未修改外部服务，也未提交推送本轮工作树。

## 最新 main 与本地程序仓库续更

程序主线继续更新后，再次通过 `dsh-deploy update` 将 232 从 `ea509f21c10472ea819d55a51b08adacc266fe00` 更新至 `1a32a74e285a5b8d50678a1d17b2f11b237315e4`，数据仍为 `2c2786edd4eefae434249482cedd4c39b9ff1ea4`。[回执](main-followup-applied.json)记录 17 个 Git 差异文件及 6 个变化制品，压缩增量包 3,521,276 字节，未包含镜像、依赖或运行状态。交付使用隔离的已提交 main，未混入本地并行改动。

首次[预检失败](main-followup-dry-run.log)暴露实例预检原地重建 Web 制品后与安装清单不一致。相同源码在本地符号链接依赖与现场实际依赖路径下构建，TypeScript 模块路径影响分块内容和名称。更新工具增加源码干净检查、现场临时重建和逐字节核对，仅接受能复现的制品；正式更新备份并修订清单，dry-run 不修改清单，无法复现仍拒绝。[工具回归 5/5](main-followup-tool-tests.log)及[预检重试](main-followup-dry-run-retry.log)通过，没有绕过工具更新。

本轮主线变更仅影响版本选择器展示，通过刷新实际加载新客户端，无需重启。平台 PID 仍为 `909528`，[安装及在线检查 9/9](main-followup-verify.log)通过；[状态比较](main-followup-state.json)确认两个业务容器身份、启动时间与镜像不变，三项现场配置摘要及原 9 个管理会话 ID 保留。一个管理会话序号正常增加；既有 `/kb-access-helper` 重启循环仍存在，本次未操作。

[已提交客户端测试 59/59](main-followup-client-tests.log)通过。232 实际浏览器的[14 项检查](main-followup-browser.json)通过：EXP027 完整后缀、变体主行版本号、名称与来源辅助行、名称搜索、身份切换与刷新保持，1440/768/390px 无横向溢出、无页面脚本异常；[桌面](main-followup-1440.png)及[窄屏](main-followup-390.png)已目视核对。只读探针拦截了页面初始化的两次空会话创建请求，不据此验证会话创建或模型交互；实际巡检仍按用户要求暂停。

本地程序 `main` 也快进至同一提交，[本地更新回执](local-main-update.json)记录两个重叠文档已三方合并，其他 92 个原有文件摘要不变、暂存区为空。本地磁盘满曾使 Git 检出中断；原始改动已有独立快照，仅清理本任务可再生成的构建文件和干净临时 worktree 后恢复完整检出，并核对受影响源码与已提交内容一致。未提交或推送现有工作树修改，未扩大清理其他文件。

最终程序工作树 `diff --check`、证据 JSON、文档链接和凭据格式检查通过；数据侧本次 EXP027 修改的定向差异检查通过。数据工作树全量差异检查在未修改的并行 VAR001 生成 ESM 中发现尾随空白，未将全工作树检查报告为通过，也未改写该并行工件。
