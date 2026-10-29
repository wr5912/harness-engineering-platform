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


## 实际生效

程序功能提交为 `9fb6acb6ca74b4833a997424271289f52744ee6e`，数据 main 为 `d499a1a3e3484bf97f6b5646a8d80e20313a7120`。正式源码工作树已同步，入口为 `http://10.0.160.32:18120/hep/`，平台 PID 为 `1530820`；18126 无监听。

启动准备按新依赖锁补编译已有工作区扩展，并通过 `prepare --offline` 同步生成的 Profile；首次构建检查和 Profile 检查失败保留在本机日志。现有数据扩展源码、配置内容和业务资产未因此修改。入口检查沿用 `HARNESS_PYTHON` 选择，4 项入口测试和 6 项生命周期／核验回归通过。

仅重载平台与 `inspection-code-only-20261026`。该实例保持原标准镜像、18502 端口、来源、运行代次和 HOME 挂载。新公开 checker 返回且只返回这一运行实例：`ready=true`、HTTP 200、`runtimeVersion=2`；`dsh-dev url` 返回同一公开入口。协议头只证明接入协议装载，另已核对程序根、进程、Git 提交和五份关键构建制品；实际制品与隔离验证构建逐字节一致，容器可见的业务与模型 Runtime 制品摘要也一致。本次为源码服务核验，不声称完成安装包的 `verifyDeployment.onlineVerified`。

重载前后管理会话 304 条、业务会话 11 条的身份集合一致，10 条评测记录一致。303 份管理会话文件摘要不变，1 份仅在原始字节前缀后追加；11 份业务会话文件摘要全部不变。浏览器检查后仍为 304 条管理会话，新增 0 条。本地部署配置与重载前逐字节一致，两份原有未跟踪研究资料也逐字节保留；它们未进入此次提交，原 stash 与分支仍可恢复。

真实浏览器最终 12 项检查通过，无页面异常：六个业务页的明暗主题与 1440／390 布局、首页四行对齐和查看全部、当前版本三图同排及真实 `2 → 1 → 1` 用例趋势、两份规范查看和下载内容摘要、受控读取失败后的恢复、窗口与助手并排，以及真实开发实例 `applied=false`／无 ACK 时按同步事实显示成功。原生管理壳及 `session/page` 的 480 条历史回读通过，未验证原生实时 `follow`。首轮窄屏主题控件定位错误属于验证脚本假设，修正后复测通过，原报告保留在 `browser/report-attempt1.json`。

本机最终回执为 `logs/deployment-receipt.json`、`logs/business-readiness-after.json`、`logs/session-file-preservation.json` 和 `browser/report.json`。检查未保存业务配置、发送 prompt、调用模型、运行新业务评测或请求真实第三方决策；相应能力以隔离 HTTP 行为测试为验证边界。
