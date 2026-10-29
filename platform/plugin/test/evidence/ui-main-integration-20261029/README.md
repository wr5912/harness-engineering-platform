# UI 与 main 功能整合核验

本次从程序 `531fd94f55b18113fbf4b33eb81674acc29a868c` 和数据 `17a3453b774ca2a18f6ddf5f654ef6a8d706a41a` 开始整合，UI 来源为 `f1a776ee8a4839ad2b4b700b893dff68e10f6b31`。推送前又同步程序 main 的 `e4c7b737058f5652fbd5a92f1e07bba098a4f511`，保留其业务入口与实际 Runtime 接入版本核验。两仓均使用隔离工作树，保留原分支、原末端和未提交资料。恢复材料在本机程序根 `.local/integration-20261029/backups/`，不随 Git 分发。

## 整合范围

六个业务页、辅助窗口、图表、读取反馈和助手浮窗采用 UI 分支实现；管理对话继续使用原生界面。第三方风险与访问控制、条件工具策略、手动兜底及两份接口规范一并整合。

`main` 的原生管理会话、版本 `loadable_assets` 解析、固定父版、源码只读和保存竞态处理、实例强制经网关创建、开发模式免签名及免许可租约、原生 Peer 与确认归属保持。已退役的平台任务、额外调用额度和交付卡没有重新接入。

开发记录同步使用真实 `synchronization`，发布许可使用 ACK；概览和访问控制不会把开发实例缺少 ACK 显示成许可过期。独立报告确认的空闲回合边界以[接口规范](../../../../../docs/platform-design/25_第三方访问控制接口协议.md)为准。

## 数据工作区

仅同步下列 9 份现用指令及工具合同，移除退役接口，保留研究指标、固定上下文、原生权限和实际证据要求：

| 文件 | 同步内容 |
|---|---|
| `AGENTS.md` | 当前工具、固定 `task_context` 和用户约定的停止条件 |
| `.agents/skills/task-builder/SKILL.md` | 现有装配、评测、实例和产物的办理路径 |
| `.agents/skills/agent-maintenance/SKILL.md` | 实际记录回读，不重新调用退役交付探针 |
| `.agents/skills/compute-variant-research/SKILL.md` | 当前作用域与 HF、ModelScope、本地模型来源 |
| `.agents/skills/kev-training/SKILL.md` | 真实训练执行器边界 |
| `.agents/skills/kev-trace-pipeline/references/platform-runtime.md` | 当前程序引用和可用入口 |
| `.agents/skills/kev-training/assets/model-evaluation-cases.json` | 仅 F01 输入的工具环境 |
| `docs/harness-research/compute-variants.md` | 当前策划字段与分阶段执行合同 |
| `docs/harness-research/controlled-improvement.md` | 真实 Job、Run、实例和失败恢复 |

原数据根已有网关部署差异与两份未跟踪研究资料继续保留；本次不提交它们。没有修改业务 Agent、Experiment、Run、Decision 或历史评判结果，也没有要求配置虚构的第三方地址。数据仓库校验通过，0 错误、0 警告。

## 验证与边界

程序验证日志、运行回执和截图集中在本机 `.local/integration-20261029/`。这里记录整合后的验证，UI 分支此前的记录见[原始验收](../ui-v26-20261028/README.md)，两者不能替代。

程序 `531fd94` 的纯 main 插件基线为 850 项：848 通过、1 失败、1 跳过。共享 Peer 测试的配置恢复未等待撤销期在途同步结束；已仅修正测试等待，保留全部行为断言。部署生命周期夹具补齐当前初始化所需模块和有效配置，运行代码未因此放宽校验。root 专属权限测试在本次非 root 环境跳过。

确定性验证已覆盖构建和类型检查、233 项后端测试（含 9 项原生工具／独立报告确认）、101 项部署与 Runtime Node 测试、最新入口相关 52 项测试、227 项 Runtime Python 测试。插件最终全量 1082 项：1081 通过、0 失败、1 项 root 专属测试跳过。

扩展仓库 Python 检查共 102 项，74 通过、6 失败、22 异常；同环境程序 `531fd94` 的纯 main 也有相同 28 项，名称和归一化首条错误逐项一致，无新增失败。主要为复制夹具排除了 `js-yaml` 依赖及历史最小 Experiment 缺少当前装载清单。比较结果见本机 `logs/repository-baseline-comparison.json`，不能将本次结果称为全仓测试全绿。容器内挂载探针不属于宿主测试集，本次未重新构建或验证容器挂载结构。

差异与凭据形态检查通过；字体许可证保持第三方原文，差异空白检查仅排除该许可证原有的一处行尾空格。代码及方案按项目审查原则复核，开发同步和冷报告确认两项实质问题均已处理。

本次不构成真实第三方服务、模型业务效果、训练、ARM64 或完整离线安装验收。
