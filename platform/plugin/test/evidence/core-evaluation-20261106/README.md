# 核心用例精简与 evaluation-review 核验

核验日期：2026-11-07 UTC，关联 `PA-01/03/12`。本次修改数据仓库当前业务评测和管理技能，程序仓库仅保存证据与验收矩阵引用；未修改 DSH 原生对话、业务 Candidate 或部署环境。

## 结果与来源

安全运营专家当前评测从 152 条、10 类场景、31 条 fast 精简为 28 条、9 类场景、8 条 fast。保留真实用户入口、必要正向闭环和有区分力的转折；沿用合法编号，承接并行故障整改的有效要求与最新编号。选择依据及未覆盖范围见[数据仓库核验记录](https://github.com/wr5912/harness-engineering-platform-data/blob/main/agents/security-operations-expert/docs/core-evaluation-20261106.md)，用例只在 Agent 的 evaluation.md 维护。

evaluation-review 及其包内模板、参考方法、平台适配现在要求先审整套真实性、独有价值、冗余、执行前置和成本；agent-maintenance、research-eval、workspace-management 与直接消费者同步。平台动作沿现有摘要校验与编辑工具，不添加对话检查或治理系统。

初始程序提交为 `9ace9eebcb2b2336da160fbfc4d05c4cbde757fd`，数据提交为 `ac0b4c244618a01cdf46acaf2e646ab3b99e2e2a`。任务使用隔离工作区，程序测试复用本机已有依赖；两仓均有其他任务的工作树修改，未将其视为本次独立交付。

## 实际验证

| 检查 | 结果与范围 |
|---|---|
| 当前来源解析与独立字节核对 | 28 条、9 类、8 条 fast，保存文件与审定稿相同 |
| 管理助手真实会话 | 读取新技能、审查、edit/preview、edit/apply、cases/list、edit/read；最终以 cases/update、cases/read 补齐访问诊断的原 HTML 再次下载；[回执摘录](assistant-receipts.json) |
| 最终单条修订后来源回归 | [1/1 通过](final-source-readback.tap)，仅变更 U-FLT-012 的输入和预期，独立字节与最终摘要一致 |
| 用例来源与策略应急工程回归 | [11/11 通过](final-targeted-tests.tap)；隔离数据，复用程序当前源码与已安装依赖 |
| 固定来源及 Run 冻结合同 | [7/7 通过](frozen-source-tests.tap)；证明工具冻结行为，不是当前业务效果 |
| 四个管理 Skill 格式 | evaluation-review、agent-maintenance、research-eval、workspace-management 的 quick_validate 检查通过 |
| 直接链接 | [14 个修改 Markdown、51 个本地链接及锚点，0 错误](local-link-check.json)；新核验记录的直接引用另行核对 |
| Skill 静态检查 | [未发现静态命中](skill-inspection.json)，只读入口检查，不代表整包语义或业务通过 |

测试命令：

```sh
# 在本次隔离数据工作区执行；程序根复用已有依赖。
HARNESS_PROGRAM_ROOT=/home/cmp/work/harness-engineering-platform \
HARNESS_ASSET_ROOT=/tmp/hep-core-evaluation-ad81zh3s/data \
node --test extensions/security-operations/tests/evaluation-source.test.mjs mcp/tests/policy-response.test.mjs

# 在程序工作区执行。
node --test runtime/adapters/dsh-container/test_evaluation_source.mjs
```

最初定向检查 [12 项中 11 通过、1 失败](targeted-tests.tap)：旧 asset-alerts 工程测试引用不存在的源码。随后隔离程序缺少 esbuild 依赖的[失败输出](isolated-dependency-failure.tap)保留；改为复用已有程序依赖后，上述受影响回归通过。没有为凑通过而恢复未知旧实现，也未声称 asset-alerts 覆盖缺口已解决。

管理助手首次审查遇到并行来源摘要变化后未写入；承接最新编号后重新预览保存。原生 bash 无法访问宿主机隔离草案路径，随后使用平台编辑工具完成保存，研发工具独立核对字节一致。该限制没有通过修改原生 DSH 消除。

最终评测 SHA-256 为 `8daf5e7c756845e8aa6103cd9ea858b4e7c5a3373adc04b49566a80a0ef0a952`。在管理助手核对迁移映射后，仅补齐既有 U-FLT-012 的只读访问诊断、中间证据及同次原始 HTML 再次下载；保存与回读成功，条数、ID、标题与档位未变。与并行任务约定保存后停止评测写入，由迁移任务统一选择同源业务验收。

## 未验证范围

未执行当前 28 条真实业务 Run、浏览器/语音业务验收、真实写入效果或同口径耗时对照；条数减少不等于耗时改善。定时研判核心两例只覆盖任务创建、修改、删除，统一网关下真实到期完整链路尚无本次证据。移出的数值、畸形响应及代码变体分支不一概宣称由工程测试覆盖，缺口保留在数据侧记录。

历史 Run 不改写，不提升业务采纳、Research Release 或 PA 路径整体状态。本次没有平台更新或重启，管理助手新读取的技能与后续 Run 使用的当前评测已生效；正在运行会话的缓存上下文不据此认定刷新。
