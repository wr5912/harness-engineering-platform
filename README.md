# harness-engineering-platform

让智能体真正可用，持续变好。

Harness 工程平台（Harness Engineering Platform，简称 HEP）面向个人开发者和内部使用：通过管理助手构建或迁入智能体，复用知识和工具，用固定业务用例检验修改，再运行或独立交付适用版本。已有 DSH、AgentScope、OpenCode 实例也可保留原框架，接入平台并按资源授权访问。

项目面向个人开发者，以平台建设和实际使用需求为主线。平台通过系统全局 DSH 装载 Cordis 插件，复用已有 CLI；程序保存在本仓库，用户资产和运行状态保存在独立数据工作区（默认 `~/harness-engineering-platform-data`）；业务智能体由独立的 DSH 容器实例执行。项目定位、开发边界和协作原则以 [`AGENTS.md`](./AGENTS.md) 为准。

程序仓库为 [wr5912/harness-engineering-platform](https://github.com/wr5912/harness-engineering-platform)，配套数据仓库为 [wr5912/harness-engineering-platform-data](https://github.com/wr5912/harness-engineering-platform-data)。已有部署可以继续使用原本地程序目录，数据根、插件包名和标准镜像名不随仓库更名而改变。

[快速开始](#快速启动) · [接入已有智能体](docs/platform-design/27_跨框架接入使用说明.md#登记与访问) · [独立部署智能体](docs/platform-design/23_离线一键打包与安装.md#单智能体独立运行包) · [查看验证结果](./docs/ai-agent-harness项目验收矩阵.md)

## 当前能力

| 能力 | 用途与边界 |
|---|---|
| 智能体构建与迁移 | 从需求新建，或将已有工程迁入为可维护的 Harness 资产，用关键任务验证行为。 |
| 知识与工具复用 | 知识保留来源，能力按版本继承或融合；通过 MCP 与 OpenAPI 接入、组合和调试工具。 |
| 跨框架智能体接入纳管、安全评估与策略授权 | 已有实例保留原 Runtime；平台管理访问入口和指定资源权限，原系统负责远端进程。 |
| 评测与持续改进 | 固定版本和用例逐例比较，区分业务效果与源码诊断，历史运行保留当时口径。 |
| 算力变体与验证 | 中算力可训练决策模型，低算力尝试代码执行；比较任务质量与资源证据，不预设等效或节省成本。 |
| 运行与独立交付 | 通过 Web 或官方 TypeScript SDK 使用；按需运行平台托管实例，或导出符合打包条件的独立运行包。 |

![平台六项能力全景](docs/assets/capabilities/overview-4k.png)

[查看4K全景图](docs/assets/capabilities/overview-4k.png) · [可编辑 SVG](docs/assets/capabilities/overview.svg)。PNG由SVG导出；能力名称与展示规格由[前端设计规范](docs/platform-design/26_前端设计规范与原则.md#56-登录页特性轮播)维护。

### 按任务选择入口

| 我的起点 | 首选路径 |
|---|---|
| 已有工程，要继续维护角色、工具或代码 | 智能体管理 → 导入／迁移，生成并验证 DSH Harness。 |
| 已有运行中的智能体，要保留原框架接入 | 实例管理 → 接入实例 → 登记已有智能体，验证并启用平台入口。 |
| 只需要交付一个业务智能体 | 选定版本 → 更多操作 → 导出独立运行包。 |

### 页面入口

| 页面 | 可以完成的操作 |
|---|---|
| 首页 | 描述业务需求发起构建、评测或改进优化；提供明确标注模拟数据的巡检体验示例，以及真实资产和运行概览 |
| 管理对话 | 由平台管理助手复用能力、装配资产、执行评测，在明确的任务与授权范围内持续修复并核验实例与业务产物；使用原生 DSH 会话，保留任务状态、草稿与模型设置入口 |
| 智能体管理 | 新建智能体和首次研究版本；搜索并查看所选版本的概览、资产、能力和运行状态，比较固定 Baseline/指定版本差异；支持融合创建、AI 特性确认、资产校验编辑、实例启动，以及固定父版派生与评测比较的算力变体 |
| 评测中心 | 新增、编辑共享用例，从 Run 冻结输入整理新用例；运行评测，阅读结构化轨迹、比较真实来源与逐例结果，记录研究决策；通过 AI Skill 抽取、复核和导出决策样本，下载完整 Run 证据 |
| 实例管理 | 管理平台托管的 DSH 容器实例，查看逐项回执；登记并访问已有原生实例，区分入口启用、资源授权及原系统生命周期 |
| 统一网关 | 按智能体身份、风险评估、访问控制三类配置；身份内包含认证方式、可信来源与撤销，查看即时任务的风险、执行限制和实例回执 |
| MCP 管理 | 管理 OpenAPI/MCP 服务、工具与资源分组及调试；维护资产告警只读查询、威胁分析阶段及父子组合的草稿与固定发布版，查看流程、执行 dry 或实际测试，将已发布组合服务加入分组 |

平台直接使用既有工具链：`dsh-dev` 管理实例，`dsh-eval` 执行评测，`run_record.py` 索引、查看和比较封存 Run，来源解析和校验器检查资产合同。编辑写回原有 Candidate、评估与 Decision，编排配置写回唯一工具目录。

完整能力状态、验证证据和缺口统一见[项目验收矩阵](./docs/ai-agent-harness项目验收矩阵.md)。当前 Preset 的 Web 创建、回流与选择闭环尚未完成（PA-09）；`release:<id>` 来源解析和实际装载尚未实现（PA-11）。MCP 组合的业务可用性还取决于上游接口和授权，dry 或工具发现成功不能替代真实业务验证。

统一网关入口为 `/hep/#/gateway`。首期只覆盖明确接入的新业务模式即时任务，不支持定时任务的检测、防护闭环；相关人工操作成本、延迟与漏执行风险见[首期范围](./docs/platform-design/05_实施路线与迭代计划.md#首期定时任务边界与影响)，所选 Mock 闭环及真实验证边界见[实施验收](./docs/platform-design/21_统一网关与MCP控制实施验收.md)。

本轮固定轨迹生成算力变体的证据与未完成项见 [LangGraph 代码变体验收](./docs/platform-design/18_LangGraph代码变体验收.md)。

## 快速启动

准备系统全局 DSH、Node.js、pnpm，以及安装了 PyYAML 的 Python；PyYAML 用于读取原生 YAML 配置和 Run 记录。DSH 版本须匹配平台插件的兼容声明；工具链已使用 Node.js 24 和 Python 3.10 验证，环境若默认使用旧版，应先调整 PATH 选择兼容解释器。PyYAML 缺失不阻止打开初始化页，准备平台时会提示为启动器所用 Python 安装该依赖。

```bash
git clone https://github.com/wr5912/harness-engineering-platform.git
cd harness-engineering-platform
./platform/dsh-platform start
```

打开终端给出的地址。首次使用按引导连接、克隆配套数据仓库或创建空白工作区；已有账号与配置保持。

### 第一个可观察结果

使用配套数据时，在评测中心选择安全运营专家的 `U-INS-001`，再查看历史 Run 的冻结预期：当前用例和当时执行口径可能不同，页面会分别展示，无需发起模型请求。空白工作区不附历史样例，可先连接配套数据；缺失样例时按页面提示办理。

### 常用管理命令

```bash
# 状态与只读启动预览
./platform/dsh-platform status
./platform/dsh-platform start --dry-run

# 本机源码更新：先核对身份、制品和在途任务，再更新
./platform/dsh-deploy update --dry-run
./platform/dsh-deploy update

# 按需停止或重启；前台运行用于调试
./platform/dsh-platform stop
./platform/dsh-platform restart
./platform/dsh-platform start --foreground

# 指定监听地址或端口
./platform/dsh-platform start --host 192.168.1.10 --port 3091
```

新业务智能体实例未指定端口时，在 `18500–28999` 中自动选择空闲端口；同名实例重启沿用已记录的端口。平台默认端口为 `18120`。

初始化页可以连接已有目录、克隆 Git 仓库或创建空白数据仓库，并预填默认登录账号，也可自行修改；已有账号保持原配置。私有仓库使用主机已有 Git 认证。终端提供一次性初始化入口；重定向日志时只输出该入口文件的位置，不将访问凭据写入普通日志。选定目录后会实际准备并接续启动平台。

打开终端显示的 `/hep/` URL，使用数据根 `.local/credentials/admin.json` 中配置的账号登录。账号在该文件维护，修改后重启生效，旧登录会话失效。查询与编辑不需要 LLM API Key；使用管理对话前，在“设置 → 模型”配置所选模型。

首页的构建、评测和改进优化都直接描述任务，无需预先选择智能体、版本或运行记录。助手先查询已有资产和证据，必要时集中澄清，再确认执行范围。“体验示例”会核对当前工作区已有的巡检工具与业务测试，使用基础 Mock 台账；缺少样例或服务时说明具体条件。当前会话与执行边界及历史交付记录见[任务交付与验收](./docs/platform-design/17_任务型智能体交付与验收.md)。

平台使用数据根 `.local/platform-home/` 保存 Session、设置及凭据（`.local/` 不提交 Git，克隆后需从本地备份恢复或按部署说明准备），再次 `prepare` 和重启会保留用户设置。使用 `stop` 停止，`restart` 重启；前台模式也可用 `Ctrl+C` 停止，再次 `start` 复用同一 HOME；“退出登录”撤销当前会话。版本兼容、认证和装载的完整合同见[当前平台接入合同](./docs/platform-design/02_系统架构与部署设计.md#当前最小平台接入合同)。

业务实例还需要 Docker、标准 DSH Runtime 镜像及所选来源声明的运行环境。将示例中的 `<experiment-id>` 替换为已有 Experiment ID，先预览来源，再按需启动或评测：

```bash
python3 runtime/adapters/dsh-container/dsh-dev up \
  --source experiment:<experiment-id> --mode eval --dry-run

python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:<experiment-id> --mode fast --dry-run
```

当前启动器的来源选择器支持 `experiment:<id>`；`--mode eval` 表示实例只读装载被测 Harness，`dsh-eval --mode fast/full` 表示评测范围，两者不同。业务实例从 `/assistant/` 访问。实例生命周期、镜像构建、工作区注册、环境变量和访问规则的唯一使用说明见[容器适配器 README](./runtime/adapters/dsh-container/README.md)。业务实例的访问设置与平台密码登录分别维护。

## AMD64 与 ARM64 主机部署

目标主机为 Linux `x86_64`/`amd64` 或 `aarch64`/`arm64`，包括 Ubuntu 24.04 ARM64；来源解析分别选择 `linux/amd64` 和 `linux/arm64`，明确拒绝其他架构。`x86_64` 是 AMD64 的主机名称，不会被拒绝。平台和业务实例在各自目标主机原生安装、构建和运行；跨架构仿真或仅检查镜像清单不能代替目标主机验收。实际通过状态以[项目验收矩阵](./docs/ai-agent-harness项目验收矩阵.md)为准。

每台主机分别安装 Node.js 24、与 [`peerDependencies`](./platform/plugin/package.json) 精确匹配的系统全局 DSH、pnpm、Python 3.10 及以上版本与 PyYAML，以及 Docker Engine、Buildx 和 Compose 插件。DSH、Node 原生模块和 Docker daemon 都须属于当前主机架构；核对 `dsh` 的可执行来源，并运行：

```bash
uname -m
node --version && dsh --version && pnpm --version
python3 --version && python3 -c 'import yaml'
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
docker buildx version && docker compose version
```

在目标主机完整克隆本程序仓库和配套[数据仓库](https://github.com/wr5912/harness-engineering-platform-data)。本程序仓库的命令见上文；数据仓库可克隆到默认数据根：

```bash
git clone git@github.com:wr5912/harness-engineering-platform-data.git \
  "$HOME/harness-engineering-platform-data"
git -C "$HOME/harness-engineering-platform-data" rev-parse --is-shallow-repository
```

最后一条应输出 `false`。不要用浅克隆代替数据仓库历史：现有业务扩展可能从固定历史提交读取源码。首次使用可按上文 `/hep/` 初始化引导连接数据仓库并建立平台账号。Git 不包含数据根 `.local/` 的持久状态和本地凭据；按[独立数据工作区合同](./docs/platform-design/02_系统架构与部署设计.md#独立数据工作区)恢复所需账号、模型凭据和 HOME，或在新主机重新配置。逐项核对数据根的 `config/sites.json`、`config/mcp-manager.json`、`config/business-access.json` 及实例启动配置中目标主机可达的地址和 `sharedSecretFile`，不要沿用旧主机的回环地址、Mock 地址或本地密钥文件路径。模型与上游服务不可用时，记录对应的装载或业务验证缺口。

在每台主机使用同一份锁定来源、本机 Docker daemon 和[容器适配器构建命令](./runtime/adapters/dsh-container/README.md#源码与镜像身份)构建一次标准 DSH Runtime 镜像，再让各业务智能体实例共用它。不要迁移另一架构的本地镜像、构建缓存或 `node_modules/`；带原生依赖的 Candidate 插件须在目标主机按锁文件重新安装，尤其是当前 `security-operations-expert` 的 `dsh-voice-hub`。先核对来源解析的 `image.platform`、镜像的 OS/Architecture、Image ID 和构建指纹，再分别执行平台 `prepare`、浏览器登录及新 Session，以及各 Agent 当前 active Experiment 的实例启动、新 Session 和所需插件、Chromium 功能检查。具体命令、装载层级和本地证据见[容器适配器 README](./runtime/adapters/dsh-container/README.md)；只在 Ubuntu ARM64 主机完成实测后记录 ARM64 通过。

单机承载多个业务智能体实例时的制品分层、实例编排、升级回滚、容量与清理边界见[单机多实例打包部署](./docs/platform-design/02_系统架构与部署设计.md#packaging-deployment)。镜像构建、实例生命周期和访问规则仍以[容器适配器说明](./runtime/adapters/dsh-container/README.md)为准。

## 离线打包与安装

在线准备机生成安装包：

```bash
./platform/dsh-deploy pack --out dist \
  --assets-dir <离线资源目录> \
  --data-root <完整数据根> \
  --image-archive <镜像 tar>
```

离线目标机解包后运行：

```bash
tar xf harness-engineering-platform-*.tar.gz
cd harness-engineering-platform-*
./install.sh --start
```

安装和 `verify` 默认使用当前用户的 `~/work/harness-engineering-platform-data` 作为程序目录、`~/harness-engineering-platform-data` 作为独立数据根；可通过 `--prefix`、`--data-root` 显式指定其他目录。

安装包必须与目标机架构一致；各架构的验证范围见[项目验收矩阵](./docs/ai-agent-harness项目验收矩阵.md)。`--data-root` 必须是包含 `AGENTS.md`、`.agents/skills`、`agents/`、`evolution/`、`config/` 和 `workspace.json` 的真实数据仓库；夹具数据根默认拒绝，仅测试可显式 `--allow-fixture-data`。安装后使用 `./platform/dsh-deploy verify --prefix <安装目录> --data-root <数据根> --url http://<host>:18120/hep/` 核对工作区、管理 Skill、默认工作区和登录页。包格式、Git 客户端、路径映射和未验证项见[离线一键打包与安装](./docs/platform-design/23_离线一键打包与安装.md)。

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
| 审查、质疑或精简已有 Skill | [`reviewing-agent-skills`](./.agents/skills/reviewing-agent-skills/SKILL.md) |
| Harness 创建、迁移、修改与优化 | [`workspace-management`](https://github.com/wr5912/harness-engineering-platform-data/blob/main/.agents/skills/workspace-management/SKILL.md) |
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
runtime/research/kev-data/               # KEV 离线轨迹、数据复核及训练输入共同实现
runtime/adapters/dsh-container/           # DSH 容器装载、评测与来源解析
plugins/                                 # 通用资产查询与 MCP 管理源码
docs/                                    # 设计、规范适用解释和验收证据入口
tests/                                   # 可重复的合同测试
AI纠错记录/                               # 按天追加的开发纠错记录
```

数据工作区保存管理助手的 `AGENTS.md`、`.agents/skills/`、研究方法文档，以及 `agents/`、`evolution/`、`config/`、业务 `extensions/` 和被 Git 忽略的 `.local/`。管理、研究、审查和表达 Skill 均由配套数据仓库维护；程序只提供加载和工具实现。目录归属和备份边界见[独立工作区合同](docs/platform-design/02_系统架构与部署设计.md#独立数据工作区)。平台从自身位置解析脚本，从 `HARNESS_ASSET_ROOT` 解析业务规则和资产，不能通过启动目录切换数据源。

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

已有跨框架实例的登记、指定资源访问与模拟验收入口见[跨框架接入使用说明](docs/platform-design/27_跨框架接入使用说明.md)。管理助手和默认 Harness 工作流继续使用 DSH；实际支持组合以项目验收矩阵为准。
