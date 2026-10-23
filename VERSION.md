# 仓库治理版本

当前版本：`0.7.0`

该版本标识仓库协作规则、研究资产语义和本地工具合同，不是 Agent/Harness Research Release，也不表示已经创建同名 Git Tag。

本版本新增离线一键打包与安装入口：`platform/dsh-deploy pack`/`install`、`prepare --offline`、Git 客户端随包、完整数据根快照与路径映射。先验证 ARM64，AMD64 打包与安装验证按用户要求暂缓；离线包不表示生产部署验收。

本版本在 Research Mode 中落实单一事实源。`security-operations-expert` 的当前业务测试只在 `evaluation.md` 维护，每个 Case 聚合名称、用户输入和预期；运行时显式选择 Case，Run 锁定所选 Case 的完整快照和摘要。技术装载、合同和工具链检查由项目测试与验收承担，被测 DSH 不挂载判分材料。

项目技能收敛为 `legacy-asset-intake`、`harness-evolution`、`research-eval` 和 `ai-correction-log`。Run 使用轻量观察合同。当前仍没有 Research Release，`release:<id>` 解析与装载尚未实现；DSH Web 完整交互和新 Preset Web 选择仍分别是 `PA-08`、`PA-09` 的缺口。
