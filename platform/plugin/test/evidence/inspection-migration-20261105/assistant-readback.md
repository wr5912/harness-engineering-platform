**此前“报告有 8 项、节点明细为空”的问题，已在该原 Run 的四个目标节点上验证恢复。** 本轮未重新巡检，未修改业务 Harness。

每页读取 2 条，实际读完：

| 节点 | 页数 | 已读／总数 | 结论 |
|---|---:|---:|---|
| `root` | 4 | 8/8 | 正常 1、未知 7 |
| `root/status` | 1 | 1/1 | 正常 1 |
| `root/baseline` | 1 | 1/1 | 未知 1 |
| `root/reachability` | 3 | 6/6 | 未知 6 |

按检查类别、对象标识、结论和说明逐项核对，均与原 JSON 报告一致，无分页遗漏或重复。基线无模板、可达性选择器及检查对缺失等 `unknown` 均保留。**Run 为 `completed`，业务结果仍为 `incomplete`，不是全部通过。**

当前 `compositionGraph` 合同已明确：
- `version=draft/published`：读取当前选择；
- `versionId`：读取真实固定版本，不能传 `published`；
- 两者择一，查询不执行节点。

[开发方法](</home/cmp/harness-engineering-platform-data/mcp/docs/composition-development.md#L12>)实际帮助了原 Run 复用、小分页读至总数、父子明细与报告交叉核对，以及执行完成和业务通过的区分。共用方法已覆盖本次经验，无需重复追加正文或索引。

研发方面，本轮明细缺口已闭环；上轮固定版本源码读取及源码／构建／装载一致性问题本次未复验，仍待核实，不能宣称已修复。
