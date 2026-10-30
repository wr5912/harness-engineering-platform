# 项目规范解释

本文说明受控来源在 `harness-engineering-platform` 平台开发与研究工具实现中的适用范围，区分当前合同、设计输入与后续能力。管理助手的业务方法与原则由数据工作区独立维护；本文保留程序需要兼容的资产与证据合同。来源版本和本地术语修订身份由 `SOURCES.md` 维护。

## 1. 当前权威顺序

1. 根级 [`AGENTS.md`](../../AGENTS.md) 定义当前项目定位、平台开发与 Harness 研究的边界及协作原则。
2. 本文解释受控来源如何适用于平台建设及对应研究任务。
3. 《Harness Repo 目录结构设计说明（v1.1）》和《Harness Asset Repository 规范（v1.0）》作为目录与资产模型的设计输入；保留来源版本、原摘要与本地修订摘要，不要求把其中每个生产化目录都物化。
4. `agent-engineering-spec` 锁定提交提供任务分流、多轮澄清和外部资产复用参考；本项目通过现有开发技能采用适用部分，不直接继承其生产交付合同。

项目以平台建设和实际需求为主线，技术不确定时开展必要研究并将有效成果转化为功能。Research Mode 是业务 Harness 研究的方法；平台功能、工具和适配器按项目路径实施与验证，不以完成全部研究阶段为前提。

受控来源中的稳定 Baseline、生产 R1/R2/R3、审批、安全控制映射和部署流程不自动成为当前要求。只有实际使用需求涉及这些能力时才明确范围与合同，并复用已有资产、来源和证据，不因项目定位变化重做已验证能力。

数据工作区 `.agents/skills/workspace-management/` 是新建、迁移、修改和优化 Harness 的对话入口。它按需求清晰程度组织澄清、计划、执行与验证，并复用资产清点、Experiment 演进和研究评估技能；已授权且必要信息齐全时连续执行，研究事实写回现有 Agent、Experiment 与 Run。

### 平台设计输入的适用关系

[`docs/platform-design/README.md`](../platform-design/README.md) 是平台设计的维护入口，包含当前接入合同与待实现能力，不属于高于根级规则的规范来源。其 R0–R5 表示按需能力演进，不是受控规范中的生产 R1/R2/R3，亦不替代 PA 路径或研究证据。阶段条件只在该目录 `05` 维护，数据合同只在 `03` 维护；归档的项目修改草案不生效。具体实施以当前需求、任务授权和验收范围为准，设计存在不代表功能已实现，也不要求所有能力按同一阶段同步完成。

## 2. Baseline、Experiment 与 Decision

Baseline 是比较起点的引用，不是一套必须复制的目录：

- `git:<40 位 commit>`：以某个 Git 提交为对照；
- `release:<agent-id>-v<semver>`：以已有 Research Release 为对照；
- `none:first-experiment`：首次实验没有既有对照。

每项语义性 Harness 变化建立独立的 `evolution/experiments/<id>/`。业务版本使用 `EXP-<agent-id>-NNN-r<12位随机十六进制>`，变体使用 `VAR-<agent-id>-NNN-r<12位随机十六进制>`；变体不得作为新版本、融合或另一变体的继承来源。既有 ID 与历史引用保留原名。最小内容包括：

- `change.yaml`：Experiment 身份、Baseline 引用、状态，以及完成后的结果；
- `hypothesis.md`：为什么修改、预期观察和停止条件；
- `candidate/`：本次要比较的 Harness 工作树；
- `evaluation/`：方法、观察、证据或总结；
- `decision.md`：`adopt`、`continue`、`reject` 或 `inconclusive` 的理由。

研究失败、停止和证据不足都是有效结果。只有实际运行值得复现时才创建 Run；只有某个研究版本值得独立保存和复用时才创建 Research Release。

## 3. 评估规模和事实边界

Evaluation 的规模由假设和拟得出的结论决定，不设固定 Case 数、固定输入数、R1/R2/R3 或全局安全用例门槛。

- 早期探索可以使用一个或少量高价值输入。
- 要扩大结论范围时，补充覆盖、反例和必要回归。
- 同一次比较运行期间保持 Harness、输入和判断口径稳定；口径变化后重新运行受影响部分。
- 每个 Agent 的当前业务测试只在 `evaluation.md` 维护；同一 Case 的名称、用户输入和预期结果聚合在一起。Experiment 不保存本地评测计划；Run 锁定所选 Case 的完整快照，作为不可编辑的执行事实而不是维护投影。
- 原始观察不得为了形成漂亮结论而静默改写；重新执行使用新的 `run_id`。

运行记录位于：

```text
evolution/experiments/<experiment-id>/runs/run-<UUIDv4>/
```

Run 至少记录实际来源、Git 提交及 dirty 状态、输入、逐项观察、失败和限制。静态检查或技术探针只能支撑其直接覆盖的结论。

## 4. Candidate 与 Research Release

`candidate/` 只是 Experiment 内的可修改工作树，不表示生产候选或发布准入。

Research Release 位于：

```text
releases/<agent-id>-v<semver>/
```

它用于保存值得复用的研究版本，必须自包含、不可变、可校验，并至少包含：

- `manifest.yaml`：身份、来源 Experiment、来源提交、评估引用、Runtime 兼容范围和制品摘要；
- `harness.yaml` 与实际 Harness 资产；
- `runtime.yaml`：重建所需的非秘密 Runtime 条件；
- `artifact-manifest.json`：逐文件摘要；
- `README.md`：用途、复现步骤、已知限制和非生产声明。

Research Release 不表示生产可用、上线批准或已经完成生产安全治理。Git Tag 不是 Release 制品；Release 也不能包含 Session、缓存、附件、LLM API Key 或整个 `$DSH_HOME`。平台和实例凭据如需版本管理，保存在 Agent 的实例专用路径，不打包为 Harness Release。

本项目不维护 `evolution/baselines/` 和 `agents/<agent-id>/current/`。前者与 Git/Release 重复保存版本，后者会制造可变别名和第二份镜像；删除这两层后，具体引用仍能精确恢复研究版本。

## 5. DSH 装载与运行状态

Harness 资产说明“要装载什么”，DSH Runtime 负责实际装载和执行。源码修改不等于当前 Session 已经生效；需要用新进程或新 Session 核对实际来源和用户可见行为。

宿主开发会话可以修改当前 Experiment 的 Candidate；DSH 被测容器只读装载同一 Candidate，并且不挂载参考答案或判断材料。该隔离用于保持比较可信，不意味着本项目要建设通用权限平台。

Runtime 的 Session、设置、缓存和附件位于独立数据根，不进入 Candidate 或 Research Release。平台和实例凭据可以使用 Agent 的实例专用仓库文件作为来源；LLM API Key 只保存在匹配 `*.llm-api-key` 的本地忽略文件中，并由环境或受控凭据机制注入。

当前平台通过系统全局 DSH 装载仓库维护的 Cordis 扩展，提供首页、管理对话、智能体管理、评测中心、实例管理及 MCP 管理。页面直接读取已有 Agent、Experiment 和 Run；编辑写回对应 Candidate、评估或 Decision，运行操作复用 `dsh-dev`、`dsh-eval` 和 Run 工具，不建立第二份资产或评估口径。平台组合、启动、插件兼容性和独立 HOME 的合同见[平台设计方案](../platform-design/02_系统架构与部署设计.md#当前最小平台接入合同)；平台功能与工具变更按 `PA-12` 及受影响 CLI 路径验证，业务 Harness 语义变化另按研究流程验证。

## 6. 三层验证

本项目只维护以下三层结论：

| 层级 | 结论对象 | 主要证据 |
|---|---|---|
| 项目与工具链验证 | 仓库规则、CLI、来源解析、容器接入、全局 DSH 平台接入 | 项目验收矩阵、自动化测试、技术探针 |
| Experiment Evaluation | 某项 Harness 变化在声明范围内的效果 | 假设、输入、Run、观察、Decision |
| Research Release 复现 | 某个不可变研究版本能否恢复并重新装载 | Release 清单、摘要、复现记录 |

三层不能互相替代，也都不构成生产部署验收。进程存在、端口监听、HTTP `200`、`/health`、文件可见或机器校验通过，只能证明对应局部事实。

## 7. 命名与物化

- Agent ID、技能名和普通目录使用小写 kebab-case。
- 业务版本与变体 ID 遵循根级 `AGENTS.md` 的[文件与命名](../../AGENTS.md#文件与命名)，均沿用 Experiment 文件合同。
- Research Release 使用 `<agent-id>-v<semver>`。
- Run 使用 `run-<UUIDv4>`。
- 只有出现真实资产、观察或复用需求时才创建目录；不使用空文件或占位报告伪造完整性。
- 外部来源原貌和迁移记录放在 `evolution/history/imports/`，不作为现行 Harness 的第二份可编辑事实源。
