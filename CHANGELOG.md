# 变更记录

本文件记录仓库治理、目录契约和公共演进工具的变化。单个 Agent/Harness Release 的变更应记录在对应不可变 Release 中。

## [0.7.0]

### 新增

- 新增 `platform/dsh-deploy pack`/`install` 离线打包与安装入口：生成含平台程序、目标架构依赖、Node/pnpm/DSH/Git 离线资源、标准镜像和可选完整数据根快照的安装包；安装器校验 manifest/SHA-256/架构，导入镜像并运行 `prepare --offline`。
- 新增 `platform/dsh-platform prepare --offline`：跳过 `pnpm install`，使用安装包内 `node_modules` 完成本地构建。
- Git 客户端随包：优先静态 Git，否则收集目标发行版 Git 与依赖库；安装器优先包内 Git，回退系统 Git时必须报告。
- 新增 `PA-13` 离线一键打包与安装部署验证路径；先验证 ARM64，AMD64 打包/安装验证暂缓。

### 边界

- 离线包包含完整数据根，默认包含平台凭据和 LLM API Key，按敏感制品管理；路径映射只覆盖平台已知文件，旧 Session 不保证。
- Docker Engine 不随包通用安装；Docker 离线安装、真实凭据跨用户恢复和业务实例启动仍未验证。

## [0.6.0]

### 变更

- DSH 镜像构建的默认 APT 主源由阿里云改为 TUNA，security 固定使用 Debian 官方源；Debian 官方主源继续作为显式回退，签名校验和构建证据合同不变。
- 新增项目审查原则唯一正文及根级按需入口；提交、代码、方案、文档、数据、开发工具 Harness 和目标智能体 Harness 按当前目标、直接影响与证据选择审查深度。
- 最高优先级原则新增单一事实源与根因整改：同一当前事实只保留一个可编辑来源，禁止补丁式修正，并把同根因检查限制在当前目标的直接影响范围。
- `security-operations-expert` 的当前业务测试收敛到一个 `evaluation.md`：每个 Case 聚合名称、用户输入和预期；删除 `definition.md`、旧 `spec/`、`eval/` 数据投影、Experiment 本地 `plan.yaml`、待复核 JSONL、阅读视图及一次性生成/导入工具。
- Run 只接受显式选择的业务 Case，锁定所选 Case 的输入与预期快照及摘要；技术装载、合同和工具链检查回归项目测试与验收，不再作为业务 Case。
- DSH 来源合同只以 `evaluation.md` 判断研究资料根，被测实例不挂载判分材料；合同 schema 升为 `2.1`。

## [0.5.0]

### 变更

- 项目明确采用 Research Mode：研究优先，禁止过度工程化和过度安全化；新增中文的简洁优先（Simplicity First）与精准修改（Surgical Changes），并将项目级安全收敛为“不提交秘钥、不自动执行不可信资产、不做未授权破坏/外部写入、如实记录结果与限制”四项底线。
- 研究生命周期改为 `Baseline 引用 → Experiment → Evaluation → Decision → 可选 Research Release`。Baseline 使用 `git:<commit>`、`release:<id>` 或 `none:first-experiment`，不再维护 `evolution/baselines/` 与 `agents/<agent-id>/current/`；Research Release 表示自包含、不可变、可校验的研究版本，不表示生产准入。
- `agent-engineering-spec` 锁定提交调整为未来生产化参考；当前 Experiment 不再默认要求固定 50 Case、17 列 Trial、REQ/AC、R1/R2/R3、安全控制映射或生产发布门禁。
- 项目技能移除 `security-control-boundary`、`delivery-review`、`dsh-release-verify`，将 `baseline-eval` 替换为轻量 `research-eval`；`harness-evolution`、仓库不变量和校验器同步研究语义。
- `run_record.py` 的 Trial 最小合同收敛为 `run_id`、`trial_id`、`input_id`、`status`、`observation`，失败/错误另记原因；Run 只区分 `research` 与 `technical`。
- 仓库校验器改为检查 Research Mode 入口、受控来源身份、四个项目技能、Experiment、Run 与 Research Release 的最小可复现合同，并明确拒绝物理 Baseline、`current/` 和已退役生产化技能。
- `security-operations-expert` 的迁移“交付记录”改为迁移来源研究评估，Experiment 状态和 Candidate 元数据不再使用退回整改、候选基线、R3 或晋升状态；历史来源与既有运行证据保持原貌。
- README、项目解释、验收矩阵、Variant 方法、研究管理 CLI 和 DSH 适配说明统一 Research Mode。项目验收仍保留 11 条一级路径，但三层结论调整为项目工具链、Experiment Evaluation 和 Research Release 复现。
- 仓库治理版本升级为 `0.5.0`；该版本号不等同于 Git Tag 或 Harness Research Release。

## [0.4.1]

### 变更

- `up --replace` 在任何停止动作前统一核对同名实例的来源、模式、端口，并在临时目录预检新 Compose 可展开；身份冲突或明显无效配置保持旧实例原状。`write_instance` 继续保留同一兼容性检查作为防御层。
- 独立 `verify-load.sh authoring` 通过来源合同生成本次目标声明并注入 `DSH_DEV_TARGET_HOST`；容器探针核对 `/work/AGENTS.local.md` 是精确只读挂载、摘要一致，且来源、Agent、`target_preset`、`session_preset` 与本次解析结果一致。verification 反向断言该路径不存在。
- 业务 `agent_id` 与运行时 `preset_id` 改为显式映射：候选 `harness.yaml.preset_id`、`sources.json.preset` 路径和基础 patch 的 `agent-presets.default` 必须相等，但不再要求等于业务 Agent ID。默认回流方法是把用户根临时候选内容合并回原稳定 ID；只有确需多个运行时 ID 时才修改三处映射，业务 Agent、Experiment 和 spec/eval 保持不变。
- 阅读视图的未来输入检查使用输出软链解析后的最终父目录和后缀，拒绝 `report.md -> eval/pending/new.jsonl` 这类悬空软链；既有同文件、硬链接、已有软链和直接 `pending/*.jsonl` 拒写规则不变。
- README、启动器方案、适配层说明和项目验收矩阵同步当前边界：Headless Skill 小闭环已验证；Web 注册与 preset Web 会话选择仍属 `PA-08`/`PA-09`。真实会话证据的正反向结论改为“降低仅凭提示重复回答的疑虑”，并提供无凭据复现说明。
- `dsh-review-followup-20260920.json` 记录 Docker 身份冲突保持原实例运行、两种独立 `verify-load` 路径、悬空软链拒写、preset 显式映射与 Web 未验证边界。

## [0.4.0]

### 新增

- `dsh-dev up --replace`：先停止同名实例自身的容器（保留 HOME 数据卷）再按新配置启动。挂载内容变化不会让容器进程自动重启，普通 `compose up -d` 也不会仅因挂载内容变化重建容器，因此重载需要这个入口或"先 `down` 再同名 `up`"。
- `ps` 每条实例输出 `agent_id`、`session_preset`、`target_preset`、`state_schema`、`needs_migration`；单条实例记录损坏时只在该条报 `error`，不再中断整张列表。
- 仓库校验器新增来源目录一致性门禁：`sources.json` 的 `preset` 必须是 `<agent_id>/<file>`。

### 变更

- **四类开发对象术语收口**：根级 `AGENTS.md` 明确四类对象与运行角色、Harness/Runtime 双平面及治理变更类型是正交关系；开发智能体“运行配置”不再泛指 Runtime Adapter 与校验工具的全部源码；运行状态与持久 Run 事实分开说明。README、启动器方案和适配层说明统一使用 `session_preset`/`target_preset`，交付记录把旧双模式上下文挂载标为历史行为并指向后续角色隔离证据。该整改不改变业务 Harness、REQ/AC、Eval 阈值或候选冻结组合。

- **开发会话直接读到本次目标**：受控开发指令保持通用（不含业务名），本次解析出的实际值（来源、目标 Agent、`target_preset`、`session_preset`、资产与受控目录）由启动器生成到实例目录，并只读挂到 `/work/AGENTS.local.md`。此前会话只能被告知"以启动器输出为准"，真实会话中确认它拿不到目标值。被测容器两个文件都不挂载。仓库校验器新增 `DSH_DEV_TARGET` 门禁。

- **会话身份与优化目标分离**：`plan`、`up`、`instance.json` 统一给出 `session_preset`（本次会话实际运行的 preset）、`target_preset`（待优化/待评估目标，始终来自来源声明）与 `agent_id`。开发模式下前两者不同（`cordis` 对业务 preset），此前的单一 `target_preset` 字段在两种模式下含义不一致。受控开发指令同步说明两者的区别与用途。
- **实例状态 schema `1.2` → `1.3`**，`target_preset` 含义收窄并新增 `session_preset`。`ps`、`logs`、`down` 不再要求状态文件是最新 schema：旧实例按记录里已有的字段重建 Compose 环境，缺失字段交给 Compose 报出变量名，因此旧实例仍可停止与查询。已停止的旧实例直接同名 `up` 即完成迁移；仍在运行的用 `up --replace` 或先 `down` 再同名 `up`；`ps` 以 `needs_migration` 标出待迁移实例。
- 端口占用区分归属：被本实例自身容器占用时给出 `down` 与 `--replace` 两条出路；被其他占用者占用时按原样失败。同名实例记录端口与 `--port` 不一致时直接失败，不自动改端口。
- **生效默认 preset 与声明绑定**：来源解析要求 `sources.json` 的 `preset` 目录等于 `agent_id`；仓库校验器要求候选基础 patch 的 `agent-presets.default` 等于该 Agent 的 `preset_id`，替换原先硬编码的业务名。新建 preset 的四处对应位置（preset 目录、`harness.yaml` 的 `preset_id`、`sources.json`、基础 patch 默认值）在受控开发指令中列明。
- **阅读视图工具**：写出前核对输出是否就是输入（含相对/绝对路径、符号链接与硬链接别名），并拒绝会落在下次渲染输入集合内的路径，被拒时退出码 2 且不改动任何输入；表格只放短字段并转义竖线，用户输入与测试前提用按内容自适应长度的栅栏块原样保留，列表项换行用缩进续行；正文顺序调整为名称与状态、用户输入、测试前提、预期行为、检查方法、关联与来源，与工具说明一致。
- `requirements.md` 由十列宽表改为短索引表加逐条 `### REQ-xxx <需求名称>` 段落，字段用加粗标签分述；稳定 ID、业务信息与机器字段不变，生成器同步并可逐字节重放。
- `dsh-dev` 的 `--source` 帮助只列出当前支持的 `experiment:<id>`；模块说明的设计合同指向当前设计方案。
- 证据 `dsh-dev-identity-and-lifecycle-20260919.json`：实机核对两种模式的身份与目标字段、旧状态实例的 `ps`/`up`/`up --replace` 行为、迁移后 HOME 数据卷保留。

## [0.3.0]

### 新增

- 根级 `AGENTS.md` 增加"开发对象与修改边界"与"文档与数据质量"两章：定义开发智能体运行配置、被开发 Harness 资产、需求与评测资料、运行状态与运行记录四类对象的用途与修改原则，并统一内容组织、数据语义、减少重复和完成检查的要求。原散布在使命、安全与资产条款中的同类约定合并去重，不保留两套说法。
- `evaluation/tools/render_pending_review.py`：按需把 `eval/cases.jsonl` 与 `eval/pending/*.jsonl` 渲染成人工复核用的 Markdown 阅读视图，只读 JSONL，不产生第二份可编辑事实源。
- `evaluation/tools/ingest_v02_spec.py` 生成的 `requirements.md` 增列「需求名称」，`tasks.yaml` 的 `goal` 改为关联需求的目标任务；`acceptance.yaml` 与 `methods.yaml` 增加来源代号图例与字段含义说明。
- `run_record.py init` 在 `inputs.lock.json` 写入 `git_version`（提交、是否含未提交修改、变更路径数）。源码版本交给 Git 后，Run 台账据此说明实际跑的是哪一版。
- 适配层新增结构性门禁：Compose 模板不得内联任何业务 Agent 的路径、preset 或 patch 名；每个挂载源必须是 `${VAR:?message}` 必填变量；`DSH_SUBJECT_GRADING_EXPOSURE` 阻止判分材料出现在被测容器；`SNAPSHOT_RETIRED` 阻止重新引入整套源码副本。
- **适配层脚本改为只读挂载，不再烘焙进镜像**：`verify-load.mjs`、`tree-digest.mjs`、`prepare-verification-home.mjs` 从 `Dockerfile` 的 `COPY` 改为由 Compose 把适配层目录只读挂载到 `/opt/dsh-adapter`（`home-init` 与 `dsh` 都挂，新增必填变量 `DSH_ADAPTER_HOST`，实例状态 schema 升到 `1.2`）。脚本改动只需重启实例，不必重建镜像，也不再出现"镜像内脚本过期"的中间状态；镜像只在源码提交、基础镜像、系统依赖或目录结构变化时重建。`verify-load.sh` 的身份核对从"比对镜像内脚本"改为"比对挂载进容器的脚本字节"，`verify-load.mjs` 另断言 `/opt/dsh-adapter` 是精确只读挂载；仓库校验器新增 `DSH_ADAPTER_MOUNT` 门禁，禁止脚本再被 `COPY` 进镜像。
- 构建期统一使用国内阿里云源：`Dockerfile` 与 `build-image.sh` 的 APT 默认源改为 `http://mirrors.aliyun.com/debian`（security 同站），并新增 `DSH_NPM_REGISTRY=https://registry.npmmirror.com`，让 `corepack prepare` 与 `pnpm install` 共用同一个国内 registry。官方 Debian 源保留为显式回退参数，只在国内源不可达时使用。换源不放松校验：APT 仍由 `debian-archive-keyring` 校验签名与 `Valid-Until`，依赖仍按 `pnpm-lock.yaml` 的完整性摘要校验；实际使用的两个源写入构建证据（新增 `npm_registry` 字段）。仓库校验器新增 `DSH_BUILD_MIRROR` 门禁，防止默认值静默回退。
- 容器级角色隔离证据：`evaluation/evidence/dsh-dev-role-isolation-20260918.json` 记录两种模式实际挂载与路径可见性；镜像按锁定提交重建，`verify-load.sh` 两种模式均通过并记录新的构建证据。
- `tests/test_validators.py` 增加模块级绑定"声明前使用"结构检查：容器内脚本曾两次在 `const mounts` 声明前引用它，只有真实运行才暴露；现在提交前即可发现同类 TDZ 缺陷（已用注入缺陷反向验证）。
- `tests/test_validators.py` 增加 `SpecDataSemanticsTests`：锁定 goal/output 不同义、需求表带业务名称且不重复、验收条目不复读套话、评估方法字段各司其职、待复核输入不重复保存来源信息。

### 变更

- **开发模式打开可写 preset 根**：`security-operations-expert.development.patch.yml` 的 `includeUserRoot` 由 `false` 改为 `true`，创造者因此可以在容器内 `copy()` 出新 preset 并试跑——此前没有任何可写 preset 根，preset 创作在容器内无法完成。受控的 `/opt/dsh-presets` 与 `/opt/dsh-managed` 仍只读，用户根只是额外候选来源。受控开发指令补充新建 preset 的完整步骤：必须用与现有 preset 不同的 ID（较早的系统根会遮蔽同名用户根）、用新 ID 开新会话验证、宿主复核后复制回 `candidate/dsh/presets/<new-id>/`。仓库校验器与 `verify-load.mjs` 同步翻转：开发模式必须出现 `includeUserRoot: true`，评测模式必须两者皆关。
- **开发会话身份与被测身份分开**：开发模式注册的工作区由 `/work/harness/workspace` 改为 `/work`，会话身份来自新增的受控只读文件 `verification-home-controls/locked-dev.AGENTS.md`（挂载到 `/work/AGENTS.md`）；目标自己的业务 `AGENTS.md` 仍留在 `/work/harness/workspace` 供阅读和编辑，但不再被注入为开发会话身份。该文件保持通用，不内联任何业务 Agent 名，目标 preset 由启动器 `target_preset` 给出。被测容器不挂载该文件，`verify-load.mjs`、`test_home_submounts.mjs` 与仓库校验器对此做正反向断言。候选业务 `AGENTS.md` 同步修正：不再声称容器内提供 `/work/spec` 与 `/work/eval-input`，改为说明判分材料不进入运行本智能体的容器。
- **判分材料与被测输入分离**：`/work/spec`（验收阈值）与判分材料根不再挂载到被测角色，容器内路径由 `/work/eval-input` 改为 `/work/eval-reference`；被测角色默认不挂任何评测材料，`/work/eval-input` 只在显式声明不含预期答案的输入根时挂载。`verify-load.mjs` 与 `test_home_submounts.mjs` 增加负向断言：这三条路径在评测容器内既不存在也未挂载。只读挂载只限制写入、不限制读取，隔离不再依赖被测实现自带的文件访问控制。
- **整套源码研究快照退役**：`snapshots/research/<snap-id>/` 的工作树副本删除，`source_contract.py` 移除 `snapshot:` 选择器，`mutation-receipt.py` 移除 `research-snapshot`/`research-snapshot-verify`，`verify-load.sh` 的 `--frozen` 不再接受研究快照。历史内容按 `evolution/experiments/<id>/snapshots/README.md` 记录的提交与路径从 Git 恢复（已逐文件核对 60/60 字节一致）。研究版本改用 Git 提交与 Run 记录表达。
- **目标身份由来源声明决定**：`source_contract.py` 从 preset 相对路径推出 `preset_id`；`dsh-dev` 的目标 preset 不再硬编码业务 Agent 名，`plan`/`instance.json` 字段由 `preset_default` 改为 `target_preset`。Compose 模板移除全部业务 Agent 默认路径与 `EXP-*` 默认值，改为必填变量。
- **`dsh-dev down` 不再无条件报告成功**：先检查 `docker compose down` 退出码，再查实际容器状态与 HOME 卷；命令失败即报错，仍有容器运行或状态查询失败时输出 `stopped: false`/`stopped: "unknown"` 并以非零退出码结束。`ps` 查询失败时标为 `unknown`，不再显示成"没有运行"。
- `dsh-dev up` 不再只看 `docker compose up -d` 的退出码：命令返回 0 后还要确认 `dsh` 服务真的进入运行状态（`home-init` 是一次性服务，正常结束不计为失败），否则报 `dsh_running: false` / `"unknown"` 并以非零退出码结束。与 `down`、`ps` 属同一类修正：命令成功不等于目标状态达成。
- `dsh-dev` 的 `ps`、`logs`、`down` 改为从实例状态文件重建 Compose 环境：受控模板用 `${VAR:?}` 声明必填变量后，这些命令不能再依赖调用者当前环境，否则停止与查询会随环境漂移而失败。实例状态 schema 升到 `1.1` 并新增 `managed_patch`；旧版状态文件明确失败并提示对同名实例重新 `up`。HOME 卷名改按 Compose 卷标签解析（Compose 会给卷名加项目前缀），`down` 输出新增 `containers_removed`，区分"容器已删除"与"HOME 卷仍在"。
- `PROJECT-INTERPRETATION.md` 第 2 节由"研究快照"改为"研究版本管理"；第 7.1 节三角色视图与实现一致；第 7.2 节不再要求物化完整冻结副本，改为记录可复核身份并由开发者保证评测期间不修改相关资产。
- 文档结构整改：`docs/DSH开发与评测启动器设计方案.md`（原 dev/eval 与创造链方案）按"背景与目标—当前能力与范围—核心对象与职责—完整使用过程—目录与配置关系—异常与既有实例—实施与验证—附录"重写，删除以 `sandbox_permissions` 被拒为由改用 shell 写 HOME 的建议；`README.md` 改为"用途—现在能做什么—从哪里开始—主要目录—演进主线"，并修正 launcher "仍处于设计阶段"与代码不符的表述。
- 技能同步：`baseline-eval`、`security-control-boundary`、`delivery-review` 的阈值来源统一指向 `spec/acceptance.yaml`，模板一仅在该文件未物化时暂代；`harness-evolution` 增加"先按根级定义识别本次对象"步骤；`repository-invariants` 与 `delivery-contract` 更新 Run 字段与快照表述。
- **生成器与事实源收敛为一条规则**：`ingest_v02_spec.py` 补齐章节小标题降级、场景引导语、需求名称与术语说明、以及每个生成文件的"首次生成、此后人工维护"声明；`tasks.yaml`、`acceptance.yaml`、`methods.yaml`、`requirements.md`、`scenario-design.pending.jsonl` 现可由脚本逐字节重放，`fixtures/*.md` 只保留维护者的"补充输入映射"纯新增段。`requirements.md` 中被改写过的源文措辞恢复为归档原文。新增回归测试锁定该不变量，防止生成逻辑与事实源再次分叉。
- 数据整改：`requirements.md` 删除逐场景重复的原始需求表并补业务名称；`tasks.yaml` 的 34 条 `goal` 不再等于 `output`；`acceptance.yaml` 移除 27 处逐条重复的通用判定句，改由文件级说明统一表达；`methods.yaml` 的 `grader`/`trial_scheme`/`aggregation` 改为各司其义并补齐可定位来源；`user-inputs.pending.jsonl` 合并重复的 `supplement` 字段。原始用户输入、稳定编号与历史证据均未改写。

## [0.2.0]

### 新增

- 将 `security-operations-expert` 旧 Harness 的业务语义迁入 DSH 容器候选 Preset、Skill、受控 Profile、MCP 声明、角色工具矩阵和原生 Guard；旧活动 Hook、权限配置和宿主部署文件不进入可装载树。
- 保存四域初版交付的清洗历史、逐文件来源清单和 200 条待领域复核输入，不创建正式 Eval、候选基线、Release 或 `current/`。
- 增加锁定 DSH 源码的薄容器适配层和 Authoring/Verification 分阶段挂载契约；为两种容器模式固定用户 Patch、Web Profile manifest、全局指令与 Boot `.env` 的只读层，并阻断可写数据卷中的同名包覆盖。
- 事实源与目录契约重构：验收事实源移至 `agents/<agent-id>/spec/acceptance.yaml`（未物化时交付记录模板一暂代）；Case 事实源移至 `agents/<agent-id>/eval/cases.jsonl`；待复核输入唯一允许位于 `agents/<agent-id>/eval/pending/`；Trial 事实按 `runs/<run-uuid>/results.jsonl` 独立归档，`delivery/eval/` 不再保存 facts 文件。200 条待复核输入迁入 `agents/security-operations-expert/eval/pending/cases.pending.jsonl`。
- 来源解析扩展：`source_contract.py` 支持 `experiment:<id>`、`snapshot:<snap-id>`、`release:<name>` 选择器，并按优化执行/被测执行/评分分析三种角色生成挂载计划，被测侧与评分侧判分材料隔离。
- `mutation-receipt.py research-snapshot` 物化完整研究快照：候选元数据、Harness 树、spec、eval 与依赖身份一并冻结，附逐树摘要与完整性复核；旧 `fr-*` 三树冻结保留可用。
- `run_record.py` 提供 Run 全生命周期：init 固定输入身份、record 逐 Trial 追加、gap 记录问题、finalize 收尾并封存 results/gaps 摘要；已收尾 Run 拒绝再写。
- 校验器新增 Agent spec/eval/issues、Experiment runs/snapshots 契约校验，并去除单一迁移实验硬编码；交付校验器改读 spec/eval/runs 事实源，删除 results.csv 读取路径。测试覆盖范围扩展到选择器、快照往返与篡改检测、Run 收尾封存、spec 与交付记录一致性、pending 与旧路径门禁。
- 开发启动器 `dsh-dev`：按 `experiment:`/`snapshot:` 选择器渲染仓库外实例 Compose（host 网络、只绑定宿主回环、每实例独立 HOME 卷），提供 `image build`、`plan`、`up`、`ps`、`url`、`logs`、`down`；`url` 只从本次进程日志取认证 URL 并做 Token→Cookie→根页探针，非交互输出必须显式 `--non-interactive`。
- 受控技术装载辅助：`stub-mcp-streamable-http.mjs` 提供只含 `initialize`/`notifications/initialized`/`tools/list` 的回环 MCP 桩（`tools/call` 默认失败关闭，不编造业务数据），`derive_mcp_stub_tools.py` 只从候选 MCP 声明派生工具原始名并对无法解析的超长引用失败关闭，使 fail-closed 的 MCP 候选在缺少真实端点时仍可核验装载。
- 开发启动器双模式：`--mode dev`（内部 authoring）以出厂 `cordis`（创造模式）preset 启动，`--mode eval`（内部 verification）以被测智能体 preset 启动；开发模式经第二层受控 `--patch` 叠加层打开出厂 preset 根，并要求显式 `--accept-cordis-trust`。两种模式都只读挂载 `/work/spec`（需求定义、任务定义、验收标准）与 `/work/eval-input`（测试夹具、评估方法、待复核输入）。


### 变更

- Experiment `evaluation/` 重组为 `evidence/` 与 `tools/`；镜像构建证据与变更回执写入 `evaluation/evidence/`；`test_security_guard.mjs` 移至 `tests/experiments/`。
- `harness.yaml` 的 `loadable_assets` 只保留运行时装载资产；`pending_delivery`/`pending_cases` 从候选装载声明中移除。
- 受控适配层安全摘要随 `source_contract.py`、`mutation-receipt.py`、`build-image.sh` 的既有变更重新审查并同步。
- `role-tool-matrix.yaml` 的父级直连集合把残留的超长旧工具名改为已登记公开号；校验器新增“技能、角色矩阵与父级直连集合中的超长 MCP 工具引用必须登记公开号”的失败门禁，仓库测试增至 146 项。
- 启动器交付 DSH Web 冷启动步骤：`plan`/`up` 输出 `workspace_to_register=/work/harness/workspace` 与操作提示。DSH 工作区注册表只从已存会话头 bootstrap，新实例 HOME 为空时界面必须先注册工作区；该锁定提交无受支持的预注册入口，启动器不改写 Runtime 存储内部格式。
- 适配层门禁扩展：两种 Compose 的挂载数由 14 增至 16，只读上下文数据资产必须精确来源；开发模式命令必须叠加受控开发层且评测模式不得叠加；新增 `DSH_DEVELOPMENT_OVERLAY` 门禁，限制开发层只能改行白名单（`agent-presets` 与 Cordis 所需 host provider 行）且必须真的选中 `cordis`；`sources.json` 与来源合同登记 `development_patch_overlay`。仓库测试增至 147 项。

### 边界

- 当前唯一交付结论仍为“退回整改”；容器技术检查、本地 MCP 桩与确定性插件单测不能替代真实模型/MCP 的 R3 业务评估。
- 开发模式的创造模式会话等同 shell 权限（含 `tool-cordis` 对实时 runtime 执行模型 JS），且不加载 sec-ops Guard、MCP 工具不受角色矩阵约束；容器使用 host 网络可直达宿主回环服务。该风险由操作者以 `--accept-cordis-trust` 显式确认并在文档披露，不构成强制控制，也不表示已隔离。
- `dsh-dev open/resume/fresh`、`release:<id>` 选择器与逐例驱动 DSH 的评测执行器仍未实施；其来源解析、快照、挂载计划与 Run 台账前置契约已交付。

## [0.1.0] - 2026-09-15

### 新增

- 建立项目级 `AGENTS.md`、最小 `.codex/config.toml` 和仓库演进技能入口。
- 纳入两份 Harness 仓库规范的受控原文，并锁定 `agent-engineering-spec` 来源提交与文件摘要。
- 定义 Baseline、Experiment、单一 Eval Set、Release/current 和 DSH 双平面的项目裁决。
- 提供旧资产摄取、演进、评估、安全、交付和 DSH Release 验收的项目工作流。

### 说明

- 本版本发布时尚未导入 `security-operations-expert` 旧 Harness 或历史交付数据；导入属于上方未发布变更。
- 本版本不包含任何可部署 Agent/Harness Release，也未完成 DSH 实机验收。
