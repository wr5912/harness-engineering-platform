# 编排与平台内置查询的归属核验

对应 `PA-12` 的 MCP 管理分项，验证时间为本地 2026-11-05（UTC 2026-11-06）。

`get_composition_run`、`get_composition_artifact`、`get_composition_details` 是平台提供的运行查询，原服务元数据将其混入 `publishedTools`，使页面误显示为用户发布的编排。本次从共享服务目录拆分 `publishedTools` 与 `builtinTools`，服务页和分组选择器分别标明来源；编排数量仅统计实际资产。MCP 发现仍合并两类工具，工具名、调用和原分组选择保持。

## 验证结果

| 范围 | 结果与证据 |
|---|---|
| 本次改动隔离回归 | 以程序仓库 `f96214fe3b970c95a2a4b6a2450c142c88d7fac5` 为基线，仅纳入本次共享服务、MCP 发现、客户端及测试修改；构建与类型检查通过，76/76 项定向测试通过。见 [build.log](build.log)、[tests.log](tests.log)。覆盖零个已发布编排仍提供内置查询、原分组选择、原生 MCP 与网关发现及调用。 |
| 浏览器客户端联调预览 | 实际开发平台及六项真实编排资产；仅在隔离浏览器中将目录响应替换为整改函数计算的服务元数据，未修改服务器数据。1440、768、390px 下显示 6 个已发布编排和 3 个内置查询，无横向溢出；原分组九项勾选保持，三项查询标注平台来源。深浅主题及页面脚本检查通过。见 [browser-preview.json](browser-preview.json)、[桌面](service-1440.png)、[手机](service-390.png)、[浅色](service-light-1440.png)、[分组](group-1440.png)。这不是服务端装载证据。 |
| 管理助手实际核验 | 真实只读任务经 `platform_mcp` 对照资产和运行目录，确认六项实际编排及三个内置查询的归属，并识别运行服务仍返回旧分类。未执行巡检、发布或写入业务资产。仅保存必要结论，见 [assistant-review.json](assistant-review.json)。 |
| 并行开发工作树 | 同轮合并工作树测试 78 项中 77 项通过、1 项下架测试失败，见 [combined-worktree-tests.log](combined-worktree-tests.log)。失败涉及同时开发的目录删除路径；同一测试在仅含本次修改的基线中通过。未将合并工作树记为全通过，也未覆盖并行修改。 |

隔离目录首次因缺少构建制品及测试所需本地父目录而失败，完成环境准备后取得上述 76 项结果；早期客户端测试还发现一处旧文案断言，已随新文案修正。浏览器探针曾匹配到隐藏组件及折叠内容，改为匹配可见服务详情并展开分组后复验，保留了数量、来源及勾选断言。

## 装载状态

维护工具 `platform/dsh-deploy update --dry-run --json` 返回 `status:busy`、`activation:none`：一个管理会话仍在执行，本次服务端变更需要受管重启。回执见 [update-pending.json](update-pending.json)。运行中服务尚未装载本次分类整改；没有强制重启、取消在途任务或绕过工具复制制品。

平台空闲且并行改动可用后，通过同一更新工具完成本地装载，再核对真实目录的 `publishedTools` / `builtinTools`、实际页面和管理助手回读。当前结论为源码及隔离回归通过、客户端联调预览通过；未执行完整业务 Evaluation 或远端部署，不提升 `PA-12` 整体状态。
