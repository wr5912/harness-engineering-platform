# harness-engineering-platform

让智能体真正可用，持续变好。

Harness 工程平台（Harness Engineering Platform，简称 HEP）基于 DSH，提供智能体资产、评测、实例和工具管理能力，并将经过验证的技术研究成果持续融入平台。

项目面向个人开发者，以平台建设和实际使用需求为主线。平台通过系统全局 DSH 装载 Cordis 插件，复用已有 CLI；程序保存在本仓库，用户资产和运行状态保存在独立数据工作区（默认 `~/harness-engineering-platform-data`）；业务智能体由独立的 DSH 容器实例执行。项目定位、开发边界和协作原则以 [`AGENTS.md`](./AGENTS.md) 为准。

程序仓库为 [wr5912/harness-engineering-platform](https://github.com/wr5912/harness-engineering-platform)，数据仓库为 [wr5912/harness-engineering-platform-data](https://github.com/wr5912/harness-engineering-platform-data)。已有部署可以继续使用原本地程序目录，数据根、插件包名和标准镜像名不随仓库更名而改变。

## 当前能力

| 页面 | 可以完成的操作 |
|---|---|
| 首页 | 描述业务需求发起构建、评测或改进优化；提供明确标注模拟数据的巡检体验示例，以及真实资产和运行概览 |
| 管理对话 | 由平台管理助手复用能力、装配资产、执行评测，在确认的范围和额度内修复并核验实例与业务产物；使用原生 DSH 会话，保留任务状态、草稿与模型设置入口 |
| 智能体管理 | 新建智能体和首次研究版本；搜索并查看所选版本的概览、资产、能力和运行状态，比较固定 Baseline/指定版本差异；支持融合创建、AI 特性确认、资产校验编辑、实例启动，以及固定父版派生与评测比较的算力变体 |
| 评测中心 | 新增、编辑共享用例，从 Run 冻结输入整理新用例；运行评测，阅读结构化轨迹、比较真实来源与逐例结果，记录研究决策；通过 AI Skill 抽取、复核和导出决策样本，下载完整 Run 证据 |
| 实例管理 | 创建、启停、重启、删除及批量操作 DSH 容器实例，查看逐项回执；获取 Web 访问入口和 iframe 嵌入说明 |
| 统一网关 | 按智能体身份、风险评估、访问控制三类配置；身份内包含认证方式、可信来源与撤销，查看即时任务的风险、执行限制和实例回执 |
| MCP 管理 | 管理 OpenAPI/MCP 服务、工具与资源分组及调试；维护资产告警只读查询、威胁分析阶段及父子组合的草稿与固定发布版，查看流程、执行 dry 或实际测试，将已发布组合服务加入分组 |

平台直接使用既有工具链：`dsh-dev` 管理实例，`dsh-eval` 执行评测，`run_record.py` 索引、查看和比较封存 Run，来源解析和校验器检查资产合同。编辑写回原有 Candidate、评估与 Decision，编排配置写回唯一工具目录。

完整能力状态、验证证据和缺口统一见[项目验收矩阵](./docs/ai-agent-harness项目验收矩阵.md)。当前 Preset 的 Web 创建、回流与选择闭环尚未完成（PA-09）；`release:<id>` 来源解析和实际装载尚未实现（PA-11）。MCP 组合的业务可用性还取决于上游接口和授权，dry 或工具发现成功不能替代真实业务验证。

统一网关入口为 `/hep/#/gateway`。首期只覆盖明确接入的新业务模式即时任务，不支持定时任务的检测、防护闭环；相关人工操作成本、延迟与漏执行风险见[首期范围](./docs/platform-design/05_实施路线与迭代计划.md#首期定时任务边界与影响)，所选 Mock 闭环及真实验证边界见[实施验收](./docs/platform-design/21_统一网关与MCP控制实施验收.md)。

本轮固定轨迹生成算力变体的证据与未完成项见 [LangGraph 代码变体验收](./docs/platform-design/18_LangGraph代码变体验收.md)。

## 快速启动

准备系统全局 DSH、Node.js、pnpm，以及安装了 PyYAML 的 Python；PyYAML 用于读取原生 YAML 配置和 Run 记录。DSH 版本须匹配平台插件的兼容声明；工具链已使用 Node.js 24 和 Python 3.10 验证，环境若默认使用旧版，应先调整 PATH 选择兼容解释器。PyYAML 缺失不阻止打开初始化页，准备平台时会提示为启动器所用 Python 安装该依赖。

```bash
# 首次获取程序
git clone git@github.com:wr5912/harness-engineering-platform.git
cd harness-engineering-platform

# 首次使用：缺数据工作区时自动进入 /hep/ 初始化引导
./platform/dsh-platform start

# 已有完整工作区，平台插件源码修改后重新准备
./platform/dsh-platform prepare

# 只预览来源、HOME、插件路径和监听参数
./platform/dsh-platform start --dry-run

# 前台启动，默认监听本机局域网 IPv4 的 3090 端口
./platform/dsh-platform start

# 指定地址或端口；仅本机使用可设置 --host 127.0.0.1
./platform/dsh-platform start --host 192.168.1.10 --port 3091
```

初始化页可以连接已有目录、克隆 Git 仓库或创建空白数据仓库，并配置首次登录账号；不会覆盖已有内容。私有仓库使用主机已有 Git 认证。终端提供一次性初始化入口；重定向日志时只输出该入口文件的位置，不将访问凭据写入普通日志。选定目录后会实际准备并接续启动平台。

打开终端显示的 `/hep/` URL，使用数据根 `.local/credentials/admin.json` 中配置的账号登录。账号在该文件维护，修改后重启生效，旧登录会话失效。查询与编辑不需要 LLM API Key；使用管理对话前，在“设置 → 模型”配置所选模型。

首页的构建、评测和改进优化都直接描述任务，无需预先选择智能体、版本或运行记录。助手先查询已有资产和证据，必要时集中澄清，再确认执行范围。“体验示例”会核对当前工作区已有的巡检工具与业务测试，使用基础 Mock 台账；缺少样例或服务时说明具体条件。任务执行、验证范围和外部预算限制见[任务交付与验收](./docs/platform-design/17_任务型智能体交付与验收.md)。

平台使用数据根 `.local/platform-home/` 保存 Session、设置及凭据（`.local/` 不提交 Git，克隆后需从本地备份恢复或按部署说明准备），再次 `prepare` 和重启会保留用户设置。使用 `Ctrl+C` 停止，再次 `start` 复用同一 HOME；“退出登录”撤销当前会话。版本兼容、认证和装载的完整合同见[当前平台接入合同](./docs/platform-design/02_系统架构与部署设计.md#当前最小平台接入合同)。

业务实例还需要 Docker、标准 DSH Runtime 镜像及所选来源声明的运行环境。将示例中的 `<experiment-id>` 替换为已有 Experiment ID，先预览来源，再按需启动或评测：

```bash
python3 runtime/adapters/dsh-container/dsh-dev up \
  --source experiment:<experiment-id> --mode eval --dry-run

python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:<experiment-id> --mode fast --dry-run
```

当前启动器的来源选择器支持 `experiment:<id>`；`--mode eval` 表示实例只读装载被测 Harness，`dsh-eval --mode fast/full` 表示评测范围，两者不同。业务实例从 `/assistant/` 访问。实例生命周期、镜像构建、工作区注册、环境变量和访问规则的唯一使用说明见[容器适配器 README](./runtime/adapters/dsh-container/README.md)。业务实例的访问设置与平台密码登录分别维护。

## 开发与研究方式

项目的工作方式和修改边界由[根级规则](./AGENTS.md#项目定位与工作方式)维护。平台开发围绕实际需求交付可用能力；遇到技术或效果不确定的问题时，做必要研究或 POC，再将验证有效的结果纳入实现。技术研究的依据按需保存在既有任务或设计记录中，不另建阶段台账。

```text
实际问题 → 必要研究或 POC → 最小实现 → 实际验证 → 能力沉淀
```

已有可靠实现路径的功能直接开发和验证。新建、迁移或改变业务 Harness 语义时，继续采用 Research Mode 的研究方法：

```text
Baseline 引用 → Experiment（含 Candidate）→ Evaluation → Decision
                                                        └→ 可选 Research Release
```

Baseline 用固定 Git 提交、Research Release 或 `none:first-experiment` 引用；Candidate 保存待比较资产；Run 固定实际来源、输入和证据；Decision 说明结果、回归、限制与下一步。评估规模按问题决定，允许 `adopt`、`continue`、`reject`、`inconclusive`。Research Release 是可复现的研究版本，不表示平台发布或生产验收。

平台实现按项目路径验证，不为普通页面、工具或启动器修改建立业务 Experiment。新增自研功能使用 TypeScript，界面使用 TSX；现有 Python 按受影响的功能切片维护，不做全仓语言重写。开发前按[分支与开发工作流](./AGENTS.md#分支与开发工作流)确定对象和修改范围，查阅[AI 纠错经验总结](./docs/AI纠错经验总结.md)与[项目术语表](./docs/项目术语表.md)。

| 工作 | 技能入口 |
|---|---|
| 平台功能、通用工具与 Runtime 适配 | [`dsh-platform-development`](./.agents/skills/dsh-platform-development/SKILL.md) |
| 平台页面任务梳理 | [`dsh-platform-task-list`](./.agents/skills/dsh-platform-task-list/SKILL.md) |
| Harness 创建、迁移、修改与优化 | [`harness-guided-workflow`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/harness-guided-workflow/SKILL.md) |
| 并行能力融合 | [`harness-experiment-fusion`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/harness-experiment-fusion/SKILL.md) |
| 旧资产只读清点 | [`legacy-asset-intake`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/legacy-asset-intake/SKILL.md) |
| Harness 实验与评估 | [`harness-evolution`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/harness-evolution/SKILL.md)、[`research-eval`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/research-eval/SKILL.md) |
| 显式盘点目标与实际进展 | [`continuous-dev-progress-vs-project-vision-gap-assessment`](./.agents/skills/continuous-dev-progress-vs-project-vision-gap-assessment/SKILL.md) |
| 用户明确纠错的追加记录 | [`ai-correction-log`](./.agents/skills/ai-correction-log/SKILL.md) |

## 主要目录

```text
AGENTS.md                                # 项目定位、协作规则与修改边界
.agents/skills/                          # 维护本仓库的开发技能
.codex/                                  # Codex 开发配置，不是业务 Harness
platform/                                # 平台启动入口、Profile、插件和管理工具实现
runtime/research/                        # 研究校验、继承检查和旧资产清点工具
runtime/adapters/dsh-container/           # DSH 容器装载、评测与来源解析
plugins/                                 # 通用资产查询与 MCP 管理源码
docs/                                    # 设计、规范适用解释和验收证据入口
tests/                                   # 可重复的合同测试
AI纠错记录/                               # 按天追加的开发纠错记录
```

数据工作区保存管理助手的 `AGENTS.md`、`.agents/skills/`、研究方法文档，以及 `agents/`、`evolution/`、`config/`、业务 `extensions/` 和被 Git 忽略的 `.local/`。12 项管理、研究和表达 Skill 均由数据仓库维护；程序只提供加载和工具实现。目录归属和备份边界见[独立工作区合同](docs/platform-design/02_系统架构与部署设计.md#独立数据工作区)。平台从自身位置解析脚本，从 `HARNESS_ASSET_ROOT` 解析业务规则和资产，不能通过启动目录切换数据源。

每个 Agent 的业务 Case 只在数据根的 `agents/<agent-id>/evaluation.md` 维护；Run 中的冻结输入是历史事实，不是第二份可编辑 Case。Git 和 Research Release 保存可恢复版本，不维护 `evolution/baselines/` 或 `agents/<agent-id>/current/`。Session、缓存、附件和整个 Runtime HOME 不作为 Harness 资产回流。

## 验证与文档入口

```bash
python3 -m pip install -r runtime/research/requirements.txt
python3 runtime/research/validate_repository.py ~/harness-engineering-platform-data
python3 runtime/research/validate_experiment.py \
  ~/harness-engineering-platform-data/evolution/experiments/<experiment-id>
```

校验器输出 JSON：退出码 `0` 表示所覆盖的确定性合同通过，`1` 表示发现问题，`2` 表示输入或读取错误。项目与工具链验证、Experiment Evaluation、Research Release 复现各自需要对应证据，不能互相替代，也不等于生产部署验收。评测执行器、封存 Run 和比较输出的具体语义见[容器适配器说明](./runtime/adapters/dsh-container/README.md)。

| 文档 | 用途 |
|---|---|
| [项目验收矩阵](./docs/ai-agent-harness项目验收矩阵.md) | 当前实现、验证证据与缺口的唯一维护位置 |
| [平台设计入口](./docs/platform-design/README.md) | 当前平台合同、能力路线与待实现设计 |
| [来源锁定](./docs/standards/SOURCES.md)、[项目解释](./docs/standards/PROJECT-INTERPRETATION.md) | 受控规范的版本、来源及适用范围 |
| [项目审查原则](./docs/项目审查原则.md) | 项目与 Harness 的审查范围和方法 |
| [VERSION.md](./VERSION.md) | 仓库治理版本，区别于 Harness Release 与 Git Tag |

受控规范作为设计输入，按当前任务采用，不自动引入生产审批、固定 Case 数或发布门禁。历史实验、封存 Run、原始导入和既有摘要保留其原有身份与事实；历史容器内修改记录见 [dsh-dev-real-session-20260919.json](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-dev-real-session-20260919.json)，不代表当前实例支持容器内修改。
