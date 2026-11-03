# 中算力变体训练链路整改计划与本地验证

日期：2026-11-02。涉及 `PA-03/04/07/08/10/12`。程序整改起始基线为 `da8ea79ceab272276140c345d990c3e992040dea`，数据整改起始基线为 `21f31456756c062ab57d26c292cedf2c63d9c549`；本记录对应其后的本地工作树修改。两个仓库的并行改动保留。

## 问题与根因

用户选择中算力变体后，期望从固定评测轨迹识别决策点，生成具有可核验标签依据的数据，在训练服务器实际训练 KEV，再验证训练工件和业务效果。原入口却统一发送 `planning_intent=plan_only`；算力任务的工具范围又固定为 `skill` 与 `platform_agents`，即使后续明确实施，也不能使用原生执行工具及 KEV 技能。数据侧技能同样把固定算力任务描述为仅策划。

比较合同只绑定决策模型身份和工件摘要，没有核对本次数据、训练、校准及测试材料，因此公开 checkpoint 与本次训练所得模型之间缺少明确区分。公开模型可以作为训练初始化，不能代替本次训练完成的证据。历史 Run 和失败结论不因本次整改改变。

## 整改计划与完成情况

| 步骤 | 交付与核对方法 | 当前结果 |
|---|---|---|
| 区分策划与实施 | 明确“仅发送策划请求”和“生成并验证变体”；分别提交 intent，发送结果未知时冻结提交，保留回读恢复入口 | 本地实现及浏览器核对完成 |
| 贯通实际执行 | 明确 implement 且非 plan_only 时恢复 DSH 原生执行能力，开放现有数据动作与 KEV 技能；仅策划保持限制并拒绝平台写入及比较 | 实际管理助手已调用原生执行工具完成 GPU 训练、开发集和校准集原始预测；部署与业务效果尚未验收 |
| 同步助手技能 | 固定来源、决策点抽取、标签复核、四用途隔离、服务器预检、训练、校准、冻结测试、工件回收和新 Run 比较 | 已在真实管理会话执行抽取、规则复核和四用途审计；AI 复核未记作人员确认 |
| 核对训练材料 | preview/create 接受训练回执引用，context 展示独立核验状态，比较与最终确认重新核对材料 | 正反例及材料变更导致结论失效通过；缺失或无效材料不能具备 end 条件 |
| 核对回归和界面 | 构建、受影响 Node 测试、现有 KEV 命令卡测试、真实浏览器加载当前组件与主题 | 通过，具体范围见下表 |
| 运行环境闭环 | 同步程序和数据技能后，用实施任务实际训练、部署并完成有效成对业务比较 | 最新代码已装载，原管理会话完成真实 GPU 训练；校准、部署与业务比较继续办理 |

训练回执的唯一合同见 [compute-generation-contract.ts](../../../src/agents/compute-generation-contract.ts)，不在文档另存可编辑 schema。核验实现见 [compute-training.ts](../../../src/agents/compute-training.ts)：核对来源 Run 集合、数据根内原始文件及 SHA-256、四分区非空、记录身份、来源组和相同决策输入的跨分区隔离、训练成功退出及实际优化步骤、校准与测试完成、三个工件与决策模型绑定的一致性。大工件使用流式摘要。计划可以暂存未训练状态，训练材料状态与构建及装载状态分别展示。

这些检查核对材料一致性，不独立证明服务器实际执行、人员标签正确或业务效果。生成伪造回执不能成为合法替代路径；执行者仍须回收真实日志和报告。现有 KEV 数据审计与编码检查继续负责详细数据语义，不另建训练调度器或复刻训练工具。

## 本地验证证据

| 检查 | 结果 | 证据与边界 |
|---|---|---|
| 当前代码完整 Node 回归 | 1504/1504 通过，无跳过 | [node-tests-current.log](node-tests-current.log)，使用运行中 RC5 的 `HARNESS_DSH_ENTRY`；此前误用旧 Runtime 的失败日志保留在本地，不计为业务失败 |
| 当前 KEV 训练工具回归 | 39/39 通过 | [python-tests-current.log](python-tests-current.log)，覆盖计划、编码检查和校准等现有脚本；不代替 GPU 执行 |
| 当前平台装载 | 通过 | [live-activation.json](live-activation.json)，更新后 325 个会话均保留，新主线接口和四分区合同实际可读，原实施任务已恢复 |
| 当前平台实际 Chrome 页面 | 通过 | [live-ui.json](live-ui.json)、[桌面](live-dialog-1440.png)与[窄屏](live-dialog-390.png)，从实际智能体页面打开弹窗，两类 intent 均可选择，无横向溢出；本次页面检查未重复提交训练任务 |
| 实际 GPU 前置核验 | 通过 | [gpu-preflight.json](gpu-preflight.json)，RTX 2080 Ti 不支持原生 BF16，FP32 CUDA 前后向及有限梯度通过；尚非完整训练或峰值显存验证 |
| 实际 GPU 训练 | 执行通过，效果待验收 | [gpu-training.json](gpu-training.json)，原管理助手执行 CUDA FP32 训练，17 条记录、3 个优化步骤、退出码 0；无截断或拒绝，监测 GPU 峰值 3629 MiB，新 adapter 摘要与公开初始化不同。仅证明本轮小样本训练，独立校准、冻结测试、部署与业务比较另行核对 |
| 训练后原始预测 | 执行通过，质量未通过验收 | [gpu-evaluation.json](gpu-evaluation.json) 引用回收的原始报告及摘要；开发集 4/5、校准集 3/7 正确，均无截断或拒绝，尚未应用校准；这些分数不构成冻结测试或业务通过 |
| 本地独立校准分析 | 已完成，未写入 checkpoint | [报告](local-calibration-report.json)与[来源核验](local-calibration-provenance.json)，原样使用固定 KEV 源码函数及回收的 7 条校准预测；三折、固定 seed，温度拟合 0.7071，交叉验证 NLL 从 1.488 升至 2.386，不支持校准改善结论。原远端作业结果仍未知，未读取冻结测试 |
| 新服务器首轮训练 | 失败，保留独立作业 | [失败回执](gpu-retrain-attempt-01.json)，基模型字节与固定来源摘要一致，34 条原生编码检查通过；离线初始化仍查询 Hub 仓库目录，训练 12.14 秒后退出 1。不能作为训练完成或新模型工件；下一轮使用已校验本地初始化目录，保留相同数据及 FP32 配方 |
| 新服务器第二轮训练 | 执行通过，效果待验收 | [原始回执](gpu4090-attempt02/train-result.json)与[日志](gpu4090-attempt02/train.log)，RTX4090、固定 FP32 配方，17 条记录、3 个优化步骤，24.38 秒后退出 0。框架峰值分配 3,486,417,408 字节；监督器记录的整卡占用包含其他进程，不能视为本任务显存。新 adapter SHA-256 为 `c7d94cb9794ed10d2e60b5866bf6974c4796fc6e52275a342dc67e0ddf2bf9e3` |
| 新模型校准与开发复测 | 执行完成，交叉验证变差 | [校准原始预测](gpu4090-attempt02/calibration-raw/report.json)为 3/7 正确；[三折报告](gpu4090-attempt02/calibration-report/calibration-report.json)的 OOF NLL 1.481→2.399、ECE 0.220→0.540、Brier 0.720→1.060，不支持改善结论。[原生温度写入](gpu4090-attempt02/calibration-write/result.json)退出 0，温度 0.7071，新 head SHA-256 为 `1c288d83be995fde06ed52d435ecd4d1af9db9b8c1bf371611f85a7233f9b56c`。[开发复测](gpu4090-attempt02/development-calibrated/report.json)仍为 4/5；报告额外温度 1.0，模型推理已应用 head 内温度，未据此调整测试口径 |
| 新模型唯一冻结测试 | 执行完成，5/5 正确 | [工件冻结](gpu4090-attempt02/freeze.json)、[head 核验](gpu4090-attempt02/head-inspection.json)、[原始回执](gpu4090-attempt02/final-test/result.json)与[报告](gpu4090-attempt02/final-test/report.json)。固定 adapter、校准 head、温度与数据后仅执行一次，作业 `pid:7649`、12.15 秒、退出 0；5 条、2 个独立组，无拒收或截断，NLL 0.748、ECE 0.519、Brier 0.343。测试后未调参；小样本结果不证明八类泛化、校准改善或业务通过 |
| 已发布代码独立核验 | 构建及 220 条测试通过 | 程序提交 `45021cc5df741ba99884333bd300693d678f5e22` 的隔离树完成[构建](published-build.log)、[216 条相关测试](published-tests.log)和[4 条生命周期测试](published-lifecycle.log)；两套测试无失败或跳过。数据侧 9 项技能修改已在 `c4a9bfbfb41fb42a63fa1f453efd2df088447891` 合入 main；不含其他任务工作树修改 |
| KEV 原生模型服务 | 冻结工件装载及远端烟测通过 | [进程与工件核验](gpu4090-attempt02/services/kev/runtime-manifest.json)、[请求回执](gpu4090-attempt02/services/kev/result.json)及[启动日志摘要](gpu4090-attempt02/services/kev/startup-log-receipt.json)，PID 8338、GPU 本机端口 18241，实际装载本轮完整 adapter 与校准 head；认证请求成功、无认证请求 401。烟测为通用问题，不证明八类路由或业务续办 |
| Qwen3.5-2B 原生语言服务 | 真实聊天、SSE、Python 与 Node SDK 通过 | [模型文件核验](gpu4090-attempt02/services/qwen/model-verification.json)、[进程核验](gpu4090-attempt02/services/qwen/native-service-identity.json)、[聊天](gpu4090-attempt02/services/qwen/native-smoke-04.json)、[SSE](gpu4090-attempt02/services/qwen/native-stream-04.json)和[SDK 回执](gpu4090-attempt02/services/qwen/sdk-stream-04.json)，固定模型 revision `15852e8c16360a2fea060d615a32b45270f8a8fc`、原生 transformers serve PID 9128、GPU 本机端口 18772。流以 EOF 结束，无 `[DONE]`；[宿主 Node SDK 7.19.0](gpu4090-attempt02/services/qwen/host-node-sdk.json)的普通及流式调用均完成，真实响应终态、用量和请求号可核对。尚未证明 DSH Workflow 装载、容器访问或业务效果 |
| 固定 Candidate 与当前用例成对评测 | 工具合同及实际装载通过，业务运行中 | [实际装载与固定摘要](evaluation-current/live-activation.json)、[CLI 6 条](evaluation-current/cli-tests.log)、[平台 83 条](evaluation-current/platform-tests.log)、[Python 81 条](evaluation-current/python-tests.log)及[构建](evaluation-current/build.log)。显式 `evaluation_source=current` 将固定父版 Candidate 与当前 84 条用例分别冻结，默认仍使用来源版本的用例，保留历史口径。当前评测没有因此认定通过 |
| 全量用例驱动输入阻塞 | 根因修复，真实进程及标准镜像通过 | 评测和复核共用的进程入口在短轮询超时后丢失剩余 stdin 写入，慢启动驱动一直等输入结束。改用匿名临时文件提供完整输入；[15 项输入与取消回归](evaluation-current/process-tests.log)通过，[标准镜像慢启动实测](evaluation-current/large-input-driver.json)完整收到 819,200 字节且 SHA-256 一致。原卡住的 `run-f748a6ea-a308-47b8-a6a3-341b1aec640b` 保留失败和停止未确认记录，随后实查两个临时容器均已移除；不计为业务结果 |
| 首轮插件类型检查与构建 | 通过 | [build.log](build.log)，在 `platform/plugin` 执行 `pnpm run build`；当前装载另见上方回执 |
| 首轮受影响 Node 回归 | 216/216 通过，无跳过 | [node-tests.log](node-tests.log)，覆盖训练材料、变体、客户端、弹窗、原生作用域、助手动作和继承作用域；使用合成训练材料，无真实训练声明 |
| 首轮 KEV 命令卡既有测试 | 15/15 通过 | [python-tests.log](python-tests.log)，从数据根运行 `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .agents/skills/kev-training/scripts/tests -p test_training_plan.py` |
| Chrome 桌面实施入口 | 通过 | [browser.json](browser.json) 的 desktop；1280×1000，实际 intent=implement，双击只发送一次，未知结果时提交冻结 |
| Chrome 窄屏实施与策划入口 | 通过 | 同一回执的 narrow/plan；390×844，分别发送 implement/plan_only，无横向溢出，主按钮整行，未知结果时不重复发送 |

Node 命令在 `platform/plugin` 执行：

```sh
node --test test/compute-training.test.mjs test/compute-variants.test.mjs test/compute-variants-client.test.mjs test/compute-planning-resources.test.mjs test/assistant-scope-switch.test.mjs test/assistant.test.mjs test/extraction-scope.test.mjs
```

浏览器使用当前真实 React 弹窗和共享主题，在独立本地页面中替换 RPC 边界，主动制造“发送结果未知”。检查包括 actual intent、重复提交冻结、视口宽度和按钮尺寸，人工核对 [桌面截图](desktop.png) 与 [窄屏截图](narrow.png)。它不证明真实平台会话送达、模型遵循技能、远端训练或业务验收。

## 运行环境验收与失败恢复

1. 在主任务协调程序、数据技能及运行中版本，按平台实际装载机制使修改生效，再从新会话选择“生成并验证变体”。先核对实际 task_context 及可用工具，不把本地构建当作 228 已生效。
2. 固定所选父版及来源 Run，读取真实轨迹与决策时点，抽取候选并保留标签依据和复核身份。按来源关联组划分 train/development/calibration/test，保证足够独立来源；数据不足则收集新轨迹，不能复制样本充数或泄漏分区。
3. 核对训练服务器认证、GPU、磁盘、KEV 版本、基模型与初始化 checkpoint。复用原生 KEV 技能执行审计、准备、编码、训练、校准与冻结测试。保留真实作业身份、退出结果、优化步骤、日志、报告及工件，不以连接 banner 或公开 checkpoint 认定训练成功。
4. 将真实材料回收到数据工作区，按唯一合同绑定回执及三个模型工件摘要。角色工件发生变化时从完整父版创建新的变体计划，不能改写旧计划、冻结 Candidate、历史 Run 或旧结论。
5. 部署所得模型，核对实际服务与新 Session 的双角色路由和工件；冻结后重新执行父版与变体两侧的新 Run，完成所选全部 Case 的质量、来源可比性和资源比较。仅在训练、装载及比较条件均满足后由用户复核 end；不自动发布或切换实例。

数据、认证、GPU 或依赖不满足时停止依赖步骤，保留已完成状态和缺口。训练连接中断时先核对原作业及日志，不能盲目重复启动；提交结果未知时先回读原请求。日志或工件丢失、摘要改变、校准或测试失败时，训练状态保持未核验，比较不能成为 end。

实际管理会话为 `session-d69bd4a4-eeda-4eb8-bb9e-af4053a8c48e`，固定来源为 `EXP-security-operations-expert-024-rad80a907c628` 与 `run-e6ffe4c8-932b-4b6a-b9fb-1f802f536408`。已抽取 49 个首个决策前样本：34 个规则可判定样本经规则和 AI 复核后进入四用途数据（17/5/7/5），15 个歧义样本隔离；原生分词器编码检查全部通过，未截断。AI 复核不是人员签核；训练分区仅覆盖三类，不能推断八类泛化。真实 GPU 训练与新 checkpoint 已核验。原服务器的校准报告作业启动后 SSH/TCP 持续超时，原作业结果未知；若恢复连接先回读 `execution/calibration-report`，不得重复启动。本地已用固定 KEV 源码的原函数和回收预测完成独立校准分析，并核对源码、输入及报告摘要；交叉验证指标未改善，不能据此认定校准成功，也未写入 checkpoint。本机网络排查已确认直连 GPU 端口没有收到 SYN-ACK，默认代理对此目标实际选择 DIRECT；未发现本机路由或 OUTPUT 规则阻断，具体上游丢包点尚未定位。使用任务隔离代理、远端 DNS 和固定主机指纹后，连续三次真实 SSH 认证成功，耗时 6.188/3.912/4.626 秒，见[恢复回执](gpu-ssh-recovery.json)。未改全局代理、DNS 或重启平台。用户随后确认此前连接错误来自 Clash 代理故障，现已修复；四路原任务已恢复，不再以此要求更换服务器。当前为另一台 RTX4090 主机，原目录不存在；管理助手在新隔离目录完成固定权重字节核验和 34 条编码检查。首轮训练因离线 Hub 目录查询退出 1；独立第二轮保持数据与 FP32 配方，使用已校验的本地初始化目录完成 17 条记录、3 个优化步骤并退出 0。新模型的开发、校准原始预测、原生校准报告、温度写入和校准后开发复测均已回收并逐一核对 SHA-256，原始回执见上表。校准后开发集仍为 4/5，校准集三折 OOF 指标变差，不支持效果改善。唯一冻结测试已完成，5 条、2 个独立组全部判断正确，无拒收或截断；冻结后未调参。该小样本结果不抵消校准 OOF 劣化，也不证明八类泛化。实际模型服务、完整业务续办和成对业务 Run 继续推进，保留新旧作业身份；业务效果与资源收益尚未验收，不能报告整体通过。最新代码仅在当前开发环境生效，未继续同步远端部署环境。
