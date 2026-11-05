# 业务文档归属规则与存量迁移核验

本轮对应 `PA-01`、`PA-03`；管理助手只读理解核对关联 `PA-12`。本轮完成目录归位、原则与技能入口调整，以及程序校验设计；不包含程序强制拦截实现，不提升业务 Evaluation 或 Research Release 结论。

## 归位结果

数据工作区：`/home/cmp/harness-engineering-platform-data`。迁移前 Git HEAD：`5b1ade86b8c79dbb97e39b1f26ba72d930927299`；原文件可用该提交和原路径恢复。本轮未提交或推送。

原 `docs/issues/` 的 1 份问题记录与 `docs/plans/` 的 9 份方案及导出件，统一迁入 `agents/security-operations-expert/docs/`，保留 `issues/`、`plans/` 子目录。根级 `docs/` 剩余 8 份 `harness-research/` 共用方法；已逐项按用途核对，不以出现业务示例作为误放依据。

迁移前后断言通过：10 个源文件全部对应唯一目标，原路径均不再存在；9 份文件 SHA-256 与原 Git 内容一致。EXP027 计划只修正 9 个相对链接，目标解析结果与迁移前完全相同，其中 2 个目标存在，7 个目标因原 027 身份路径已不存在而在迁移前即失效。本轮新增失效链接为 0，未将历史引用替换为当前版本或改写历史事实。当前文本中没有发现引用这些原文档路径的入站链接。

未修改业务 `evaluation.md`、`config/business-access.json` 的既有改动；两者核验前后摘要一致。现有并行 Experiment、制品及上一任务的评测删除实现保留。

下表路径均相对该智能体的 `docs/`；除 EXP027 计划外，摘要同时适用于迁移前后内容。

| 文档 | 迁移后 SHA-256 |
| --- | --- |
| `issues/SOC任务级预检失败-2026-10-29.md` | `cc6bffb2fea215a1ddeef9ddc82eed81105d0deb6b7e795ed802fec9422625e6` |
| `plans/EXP027-身份表达与巡检执行整改计划-2026-11-03.md` | `0e86aaeb945030bbf881b7662d6663729bec3a72e875bd005a9ef988f63d5e85` |
| `plans/应急处置（响应处置）服务方案-2026-10-29.html` | `160e8b15cf59d8f585e1bdccd436556bab184eb6b1cf2b6dcae9bc810f08f4a8` |
| `plans/应急处置（响应处置）服务方案-2026-10-29.md` | `5c53061ac3ecb522203d849186d1fd61f11c55a2661297b392a808b2d3a62a9c` |
| `plans/应急处置（响应处置）服务方案-2026-10-29.pdf` | `27acff59577518efa0d0c1e61c1675e6f63b25324c5bf61b2c91b4aba77aaf97` |
| `plans/按部门生成与下发策略实施方案-2026-10-29.md` | `415f1b9e06ad26c41d1ad85df29005829eb40aae0edb41b1663fcf89422f9eef` |
| `plans/策略生成与配置完整功能设计方案-2026-10-29.md` | `037796d1560293ba1dfb959cd7719f61821fc849fd2481db16b96d6c735b22b1` |
| `plans/策略生成与配置服务方案-2026-10-29.html` | `69e646f9cdbb6ae30a35717059abcd31ab06de3815eb4d54e38753f657f290e3` |
| `plans/策略生成与配置服务方案-2026-10-29.md` | `faee343be0df095a0808997fce3ab3d20398b4155be95743ac838ce74a0e1a3e` |
| `plans/策略生成与配置服务方案-2026-10-29.pdf` | `8b5e05fdf03a52e99bec9bb630705a9f1ebdeca11fdee2e84fe8677633ab74d0` |

EXP027 计划迁移前 SHA-256：`e250a897076b025de2fa07871cfebe684bbf70f9a53f0d2f7f6ec3fe2413fe0b`。

## 规则与设计

程序与数据工作区的 `AGENTS.md` 明确业务文档归属为硬性限制；数据侧 `workspace-management` 只引用其业务原则，不复制规则正文。程序 [03 数据合同](../../../../../docs/platform-design/03_存储架构与数据契约.md#业务文档归属与校验)集中维护写前核验、路径推导、并发与失败恢复、原生工具边界及只读巡检的设计；02 目录合同只引用。

现有 `research/validate` 仍校验 Experiment，尚无本设计的统一文档保存、原生写入拦截与全仓归属校验入口。不能以本次手工清点、目录断言或助手回答代替这些程序能力。

## 管理助手只读核验

在当前本地平台新建管理会话 `session-42cf2cc2-f080-48d8-bbb6-41e2953baa08`，固定 Agent 为 `security-operations-expert`，要求只读核对当前规则与程序设计。任务正常结束，实际工具调用为 `skill`、`read`、`grep`、`read`，没有文件写入或外部服务调用。

助手正确回答：具体业务文档及导出件应进入 `agents/security-operations-expert/docs/`，要求写入根级 `docs/plans/` 时指出冲突并给出正确目录；共用方法、`evaluation.md` 与历史 Run 保持原合同。助手同时指出写前拦截与全仓巡检尚待实现，原生 `bash` 直写不能靠 shell 正则宣称已全面受限。此项证明当前新会话的规则理解，不证明程序已能拒绝违规写入；未进行实际违规落盘探针。

## 核验范围

- 两仓 `git diff --check` 通过，调整涉及的本地文档链接已核对。
- 无业务 Harness 语义修改，未创建 Experiment、执行业务评测或重写历史 Run。
- 未重启平台或业务实例，未部署远端，未执行全仓代码测试。
