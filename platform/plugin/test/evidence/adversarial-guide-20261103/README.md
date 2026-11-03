# 全项目对抗性审查与指南吸纳证据

本目录保存2026-11-03执行回执和源码快照。发现、优先级、覆盖及后续安排唯一维护于[审查报告](../../../../../docs/项目对抗性审查_2026-11-03.md)；本目录不维护另一份整改清单。

## 来源与实际执行

- `baseline.json`：两仓提交、原工作树状态及需要保留文件的摘要。
- `sources.json`：本次修改的规范/方法文件字节摘要，另列管理原则trim正文摘要，二者对象不同。
- `platform-review.md`、`runtime-review.md`、`data-review.md`、`ui-review.md`：并行专项的执行时原件快照，只保留本次观察，不作为后续可编辑事实入口。
- `method-final-review.md`：方法与四个新会话公开回答的独立复核，保留部分满足和表述越界。

## 反例

| 报告发现 | 实际回执与执行时探针 |
|---|---|
| F01 首次事件派发决定过期 | [回执](stream-initial-expiry-probe.json)、[源码](stream-initial-expiry-probe.mts) |
| F02 编排回执未知被显示为失败 | [回执](composition-unknown-probe.json)、[源码](composition-unknown-probe.mjs) |
| F03 坏批次影响健康对象 | [回执](data-repros.json)、[源码](data-repros.mts)，仅`datasetIsolation`作为确认问题 |
| F04 迁移路径级联替换 | [回执](runtime-path-rewrite-repro.json)、[源码](runtime-path-rewrite-repro.mts) |
| F05 公开入口绑定冲突 | [回执](runtime-public-url-repro.json)、[源码](runtime-public-url-repro.mts) |
| F06 SDK中文跨块乱码 | [回执](runtime-sdk-utf8-repro.json)、[源码](runtime-sdk-utf8-repro.mts) |

探针是执行时源码快照，相对导入和执行目录以原程序根`.local/audit-guide-20261103/`为准。先阅读再在隔离目录复现，不把这些快照当作新增平台功能或自动执行入口。`stream-lease-probe`与`data-repros.trainingSource`用于说明不列为确认问题的边界。

## 工具链、页面与管理助手

测试原件分别为`platform-targeted-tests.log`、`platform-ui-control-tests.log`、`runtime-tests.log`、`runtime-source-tests.log`、`platform-prepare-tests.log`、`skill-inspector-tests.log`。`assistant-tests.log`保留旧lib导致的一项失败，`assistant-scope-built.log`是隔离新构建的定向复验，没有覆盖原失败记录。`prepare.log`保留隔离类型检查/构建结果，`repository-validation.json`保留仓库合同结果。

三轮`ui-2026-*`目录保留实际页面和原始报告，包含初次脚本选择器覆盖失败和后续补测；状态数含重复，不表示同数量的独立业务用例。原生初始化及业务写入被浏览器保护阻断，管理对话只验证空态壳；`ui-review.md`说明主题恢复、会话和覆盖边界。

`assistant-configuration.json`、`assistant-behavior.json`、`assistant-load-and-tools.json`记录独立平台四个真实新管理会话的实际装载、公开回答和工具摘要，不归档模型私有推理。`ui-assistant-configuration.json`及`current-methods.json`是原18120的只读配置/方法核对；不据此声称所有旧会话重跑过新方法。

`start.log`、`stop.log`和`stopped-status.json`记录独立验证平台生命周期。原平台和业务实例未重启，独立平台已停止。LLM凭据仅保存在被忽略的专用本地文件，没有复制到本目录。凭据扫描范围和结果另见`credential-scan.json`，截图不做OCR，不由此宣称全仓无秘密。

数据类JSON是实际只读统计、解析和资格核对回执，不是新的可编辑资产目录。没有保存业务正文副本、原生HOME、Cookie、私钥或模型API Key。跨仓方法中的指南来源链接已按当前本地文件核对；本轮没有提交推送，远端新增锚点尚未随本轮发布。
