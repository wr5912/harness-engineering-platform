# 规范来源锁定

本文件记录输入规范的版本、原始摘要与恢复定位，以及当前本地修订身份。经明确授权的本地术语修订沿用路径并标明新版本；上游版本升级另行记录来源与适用影响。各来源对平台开发和 Harness 研究的适用范围见[《项目规范解释》](./PROJECT-INTERPRETATION.md)。

本地术语修订核对日期：2026-10-13。外部研发规范条目保留 2026-09-23 的锁定信息，本次未重新访问外部仓库。

## 目录与资产模型参考

| 规范 | 受控副本 | 输入原版 SHA-256 | 当前副本身份 |
|---|---|---|---|
| Harness Repo 目录结构设计说明 v1.1 | [`Harness_Repo目录结构设计说明_v1.1.md`](./Harness_Repo目录结构设计说明_v1.1.md) | `47e91605ebff45baf269c7f85218ce69c58ada0a6cd78c8f7d8e5524bea44705` | 2026-10-13 本地术语修订版 |
| Harness Asset Repository 规范 v1.0 | [`Harness_Asset_Repository规范_v1.0.md`](./Harness_Asset_Repository规范_v1.0.md) | `9a83b79a4b48cac99f8f56e69f9b63e2d9c78bb3db5f75be6f7e4501685fd502` | 2026-10-13 本地术语修订版 |

上述摘要标识输入原版。两个修订前副本均可从 Git 提交 `6560e86291100d9bab89016e2194e64a19654d08` 的同路径恢复，并与原摘要核对。当前本地术语修订版的预期 SHA-256 只在[仓库校验器的 `STANDARD_COPIES`](../../runtime/research/validate_repository.py)维护；校验器仍拒绝摘要漂移，本文不重复维护当前摘要。术语说明不改变原规范的历史架构和生产语义，其当前适用范围由项目解释确定。

## 外部研发规范参考

- 仓库：`git@github.com:wr5912/agent-engineering-spec.git`
- 锁定提交：[`aa3f27ae0b785191d0a122a6857154640073d73b`](https://github.com/wr5912/agent-engineering-spec/commit/aa3f27ae0b785191d0a122a6857154640073d73b)
- 2026-09-23 核验记录：当时本地 `main`、`origin/main` 和上述提交一致，工作树无未提交变更。
- Tag 边界：`v1.2` 是一个 annotated tag；其 Tag Object 为 `f97358c964fc96f05e3b8202e127fcf5a5c038f1`，解引用后指向 Commit `fa51364796c6c338d45372527a1c6733d3236198`，不是当前锁定提交。不得以 `v1.2` 替代本文件记录的 Commit 引用。
- 保留方式：仅记录 Git 来源、Commit、采用文件和文件摘要，不在本仓库复制整套规范正文。

下表记录本次检查过的文件和摘要。当前只采用其中与研究范围一致的任务分流、多轮澄清和外部资产先清点后复用原则，具体执行入口是项目技能 `workspace-management`；固定 Case 数、R1/R2/R3、安全控制映射、候选基线和生产发布门禁仍仅作未来生产化参考。

| 参考文件 | SHA-256 | 内容索引 |
|---|---|---|
| `README.md` | `720d3e24827e49880208d7add9d9ed00c3d3d674acfc9508f239c6ff0f166457` | 使用入口、任务路径与文档导航 |
| `00_总纲.md` | `4d6c96da4c8be782b9f4956e72d41989a57ae8d12534d8e1b4f54672e85b0168` | 权威术语、角色、状态、风险与证据红线 |
| `01_研发流程与按需探索验证.md` | `d5608891aa951f9f07a63fefd0e8aa3bef203f1597498644b44caa553cebb867` | direct/exploration 路径、候选基线、复核与失败路由 |
| `02_需求定义与场景输入规范.md` | `b7e43ad8080dd164160370ba92ce539c9abdc59b6e03725582fd87f9785531c1` | `REQ-xxx`、`AC-xxx`、任务边界与输入覆盖 |
| `03_Harness开发与变更规范.md` | `5b3243040e3e32fbfbc2cf03a3a5efbddb2f28ea4184546d65f1fda555f41cc8` | Harness 设计、变更、迁移和冻结项 |
| `04_评估测试与回归规范.md` | `07e57b47cd3733f623bc985dceb61abd41cbbd76b85761a854eb389bf3d9b520` | 单一 Eval Set、正式范围、Case/Trial/Run 和机器结果契约 |
| `05_安全控制边界规范.md` | `ea33023ebf1dddf8ef5f9d4e0964c92930d16d9536d97b1b32a566d2d81d0f33` | 数据、工具、权限、审批、隔离和失败安全 |
| `06_交付评估与发布规范.md` | `ca7dfe7aa2ebb296ad8c3105c94973fc83db5812c684919a488cff1bcbf35afc` | 唯一交付目录、R1/R2/R3、发布验证和回滚 |
| `07_研发交付六件套模板.md` | `7c95b09bb15bc6acd3e588e9c209029a5bc6dfe7cb04f9faac7c70bffe12bb4d` | 六项交付内容、ID 生成与填写接口 |
| `08_最小实践示例_告警研判与处置.md` | `b5d1f6f57aaea547bd356f82f9e96684ba679a9d2b6696e04c9e7686659346c2` | 安全运营场景的完整研发、整改与发布示例 |
| `09_研发检查清单.md` | `f67cbe0c08d76a2555b460591e490dc151154db7db994cf6b4e505f6b8db293e` | 开发、交付和发布前的执行清单 |
| `10_外部资产复用与集成.md` | `e99d3a1e72b3415592dfb664d02eb74e6c669c7bf600c782e1a30c425cddbae0` | 外部资产盘点、选择性复用、适配与验证 |

## 更新与核验规则

1. 受控副本内容发生变化时，必须把它视为新来源版本，不得只更新摘要后继续声称是原 v1.1/v1.0。
2. `agent-engineering-spec` 升级时，先锁定新的 Commit，再比较相关文件；Tag 只作辅助名称，不能代替 Commit。
3. 来源升级不会自动改变已有 Experiment 或 Research Release。采用新规则时说明原因和影响范围；只有业务 Harness 语义变化才建立或继续对应 Experiment。
4. 三项来源在本项目中的适用关系见[《项目规范解释》](./PROJECT-INTERPRETATION.md)。
