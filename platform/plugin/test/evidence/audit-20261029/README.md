# 2026-10-29 合同与交互验证

本记录为提交 `03633612af555e12e96b6fda23d34534d07ead0a` 携带的历史验收说明；下文“本工作树”指当次核验工作区。整合到当前工作区不表示已重新执行这些检查。

程序基准为 `dda4afa98a1d9414e74124a7b6ba56f6239863e3`，数据基准为 `d499a1a3e3484bf97f6b5646a8d80e20313a7120`。数据工作树有既有修改，本轮只读核对，未改业务资产。输入报告和证据包位于用户提供的 Downloads 路径；证据包内各文件 SHA-256 均核对一致。

- DOCX SHA-256：`e96736e2f47d98c3aa0b6ab4f8b25340134d28edcb63d77cdf065675e2fed73b`。
- ZIP SHA-256：`210b8d0708fbf624233d0750dc8f11664d5dfb0828c7580893311b711ccedfdb`。

下表对应报告的 15 项发现，均在基准源码中确认成立，编号仅用于对照输入。

| 报告项 | 当前行为 | 主要回归文件（相对 `test/`） |
|---|---|---|
| R01 | 新旧计划统一计入压缩、辅助请求、子 Session 和图内 Token；用量不足不可确认 end，历史确认需按当前口径重核 | `compute-variants.test.mjs`、`model-usage.test.mjs` |
| R02 | 原请求 ID 对应同一持久 Job；丢回执、页面刷新、跨范围及迟到恢复均保留原目标和参数 | `evaluation-client.test.mjs`、`evaluation-jobs.test.mjs` |
| R03 | 发布请求头携必要上下文及限制版本；完整快照经控制正文同步 | `business-gateway.test.mjs`、`business-entry.test.mjs` |
| R04 | v2 调用按目标来源刷新，保留其他来源的名称与冲突判断 | `mcp-group-v2.test.mjs` |
| R05 | 算力确认核对 Decision 摘要；写入失败恢复本次变更，并发新正文保留 | `compute-variants.test.mjs` |
| R06 | 文本保存和失败回滚保留已有文件的执行权限 | `agents.test.mjs` |
| R07 | 组合测试、发布、执行和阶段恢复期间固定提交输入 | `mcp-composition-client.test.mjs` |
| R08 | 手动计划与结论按 Agent/Experiment 暂存，慢父版读取不覆盖研究范围和诊断 Run | `compute-variants-client.test.mjs` |
| R09 | Agents、Instances、MCP 隐藏时记脏；首次读取和通知按对象合并，在途旧对象不阻塞新对象 | `agents-client.test.mjs`、`instances-client.test.mjs`、`mcp-composition-client.test.mjs` |
| R10 | Session 观察按实际字节分批、全部验证后导入；失败保留旧确认，末批重复可确认 | `business-gateway.test.mjs` |
| R11 | 编辑和 Case 入口共用严格版本身份校验，错配对象局部失败 | `agents.test.mjs`、`evaluation-cases.test.mjs` |
| R12 | Git 收集、校验和复制共用固定包内入口，自定义 PATH 来源删除后仍可执行 | `platform/deploy/test/git.test.mjs`（相对程序根） |
| R13 | 样本列表分别表达加载、失败、成功空和有数据；恢复不清除独立保存冲突 | `dataset-view.test.mjs` |
| R14 | 研究夹具共享锁定 Node 依赖、沿用入口 Python、声明最小装载资产；绝对截止时间走取消、停实例与封存路径 | `tests/test_validators.py`、`runtime/adapters/dsh-container/test_dsh_eval_cancel.py`（相对程序根） |
| R15 | README 的部署 verify 命令使用受管基地址 `/hep/` | `platform/deploy/test/verify.test.mjs`（相对程序根） |

执行环境为 Node `v24.19.0`、Python `3.10.12`、锁定 DSH `0.2.1-rc.2`。最终结果如下；日志相对本工作树 `.local/adversarial-review-20261029/`。

| 检查 | 最终结果 | 原始记录 |
|---|---|---|
| 插件类型检查、离线构建 | 通过 | `typecheck-final.log`、`build-final.log` |
| 插件全量 Node 回归 | 1114 项，1113 通过、1 跳过、0 失败；跳过项要求 root 身份，本次以 admin 运行 | `platform-final.tap` |
| 根 `tests/` Python 全量回归 | 102/102 通过 | `python-verified.log` |
| 取消、到期与进程清理专项 | 4/4 通过 | `python-cancellation-final.log` |
| 部署、生命周期和适配器回归 | 64/64 通过 | `deploy-runtime-final.log` |
| 程序仓与数据仓合同 | 两者 valid=true，errors/warnings 均为空 | `program-validator-final.json`、`data-validator.json` |
| 原生组件浏览器交互 | 12/12 通过，页面异常为 0 | `browser/result.json` |

首轮平台全量的 3 项失败保存在 `platform-first-complete.tap`；Python 依赖准备、解释器及到期用例准备预算的失败保存在 `python-before.log`、`python-final.log`、`python-complete.log`。最终全量均重新执行，未以跳过失败替代通过。

浏览器使用锁定 DSH 实际装载的 React、Modal 和原生样式，将当前 TSX 装入独立浏览器根；RPC 仅在外部边界替换。1440px、390px 各覆盖样本状态恢复、手动草稿重挂、组合输入冻结、评测丢回执、未知请求重挂及隐藏页面通知，共 12 项；页面异常为 0。截图和原始执行日志保存在本工作树忽略目录 `.local/adversarial-review-20261029/`。

运行协议测试经过真实 Cordis/DSH、HTTP、WebSocket 和 MCP 接缝，外部服务使用本地夹具；覆盖 700 Session 跨正文边界同步、中断重试和末批确认，以及累计 80 条风险事实后的正常 HTTP 和新 WebSocket 接入。完整 MCP 发现仍访问所选成员；尚未发现名称的资源需先发现，不能据此声称首次发现无等待。

真实数据仓只发现一个仍为 exploratory 的算力变体，没有既有算力 end/adopt 需要重算。本轮未调用模型、业务 MCP、训练服务或业务实例，不改写历史 Run 或研究结论。浏览器和隔离协议测试不代表共享 18120 或既有业务 Runtime 已装载新制品；插件按既有只读挂载更新，无需因此重建标准镜像，实际重载后仍须验证受影响入口。
