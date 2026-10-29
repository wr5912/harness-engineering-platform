# DSH 容器薄适配层

本目录固定官方 DeepSeek Harness（DSH）源码构建身份和卷装载方式；不开发、不复制 DSH Runtime 源码到本仓库，也不把宿主机 Codex 项目协作配置交给 DSH。`source.lock.json` 是全仓唯一的当前 DSH 版本声明；各 Experiment 的 `change.yaml` 声明版本身份，`candidate/harness.yaml` 声明装载资产，平台按版本目录发现可选 Candidate。

## 程序目录与数据工作区

命令在程序仓库执行，业务资产和记录位于独立的数据工作区，默认 `~/harness-engineering-platform-data`。`HARNESS_ASSET_ROOT` 可显式选择数据工作区；`HARNESS_PROGRAM_ROOT` 由程序位置确定，平台启动器会显式传入。来源解析、评测和实例命令也支持 `--repo <数据根>`；`dsh-dev` 的该参数放在子命令之前。

```bash
export HARNESS_ASSET_ROOT="$HOME/harness-engineering-platform-data"
/usr/bin/python3 runtime/adapters/dsh-container/source_contract.py --source experiment:EXP-security-operations-expert-024-rad80a907c628
/usr/bin/python3 runtime/adapters/dsh-container/dsh-dev --repo "$HARNESS_ASSET_ROOT" ps --all
```

程序保留 `source.lock.json`、运行适配器与校验 Skill；数据工作区保留 `workspace.json`、`config/`、`agents/` 和 `evolution/`。当前装载不依赖全局来源表；固定历史提交的恢复只兼容该提交自身的旧声明，具体合同见[版本身份与装载声明](../../../docs/platform-design/03_存储架构与数据契约.md#版本身份与装载声明)。校验器从程序侧读取规范与实现，不要求把程序文档复制到数据仓库。评测工具使用 Python 3.10 或更新版本，TypeScript 入口需要 Node.js 24；检查 PATH 时应同时核对这两个版本。

## 源码与镜像身份

`source.lock.json` 锁定官方仓库提交、Git tree、`pnpm-lock.yaml` 摘要、包管理器版本和 Node 基础镜像 OCI index digest；当前锁定 `v0.2.1-rc.2`，Web 组合原生包含 Schedule 服务和任务界面。所有 Experiment 共用这份锁。宿主来源解析将 Linux `x86_64`/`amd64` 映射为 `linux/amd64`，将 Linux `aarch64`/`arm64` 映射为 `linux/arm64`，其他系统或架构明确拒绝。构建指纹和本地镜像标签包含解析出的平台，因此同一锁定源码在两种架构上的镜像身份不同，不能混用。宿主来源解析脚本不进入 Runtime 镜像，因此不参与镜像构建指纹。`build-image.sh` 新建临时源码工作树，在宿主侧核对提交、tree 和锁摘要后用 BuildKit named context 构建。官方构建脚本支持显式 `DSH_CLIENT_COMMIT_HASH`；构建器不依赖 named context 是否携带 `.git`，只安装本地 C 编译及 musl 工具，最终镜像不保留这些构建工具或 `.git`。本仓库没有 DSH 源码副本。

```bash
bash runtime/adapters/dsh-container/build-image.sh
# 多来源时显式选择：build-image.sh --source <experiment-id>
```

APT 索引使用 `Error-Mode=any`、单次重试、30 秒 HTTP 连接超时和 IPv4；失败必须中止，而非沿用不完整索引。默认主源使用 `http://mirrors.tuna.tsinghua.edu.cn/debian`，security 保持 `http://deb.debian.org/debian-security`；TUNA 不可达时可显式加 `--apt-mirror http://deb.debian.org/debian` 回退到官方主源。构建前先用同一锁定 Node 底座执行 Debian archive keyring 签名的 APT 更新预检，main、updates、security 任一签名或索引失败即停；Dockerfile 中再次校验，构建证据记录两条实际镜像 URI。回退源改变了构建期软件包的分发路径、可用性和更新时间边界，虽未降低 Debian 签名校验，也不能把它说成与默认源的网络来源完全相同。

本机 Docker 构建网络异常时还可显式加 `--build-network host`，但这会让构建步骤直接使用宿主网络命名空间；默认仍为 Docker 隔离网络。镜像源与网络选项都不改变锁定 DSH 源码和 Node 基础镜像身份，实际值写入构建证据。

镜像构建使用官方 `DSH_GATE_CONCURRENCY=1` 串行执行构建 gate，避免 Host 编译、打包和整体验证同时占用共享开发主机的内存；不修改官方源码或 Runtime 运行配置。

成功构建后脚本根据 `source.lock.json` 和镜像构建输入计算 `image_build_fingerprint`，并把它写入 OCI label；同时打印实际本地 Image ID，并向本 Experiment 的 `evaluation/evidence/dsh-image-build-<UTC>-<PID>.json` 写入只追加的本地构建证据。也可以指定 `--evidence-output FILE`。`source.lock.json` 仅锁构建输入，不填写未取得的 Registry digest；本地标签可重指向，运行前会同时核对标签、Image ID、构建指纹和平台，不能把标签当作不可变身份。

## 候选资产装载

| 容器路径 | 宿主机来源（所选 Experiment） | 评测实例 |
|---|---|---|
| `/work/harness/workspace` | `candidate/dsh/workspace` | 只读 |
| `/opt/dsh-presets` | `candidate/dsh/presets` | 只读 |
| `/opt/dsh-managed` | `candidate/dsh/managed` | 只读 |
| `/work/reference` | `agents/<agent-id>` | 不挂载 |
| `/work/eval-input` | 显式声明的被测输入根 | 仅在显式声明时只读 |
| `/var/lib/dsh` | `<数据根>/.local/instances/<name>/dsh-home` | 运行状态可写 |
| `/opt/harness-config/sites.json` | `<数据根>/config/sites.json` | 只读 |

评测实例不挂载 `evaluation.md` 或其他判分材料；`verify-load.mjs` 与 `test_home_submounts.mjs` 对此做负向断言。Harness 修改由宿主开发会话完成，容器只负责装载和评测。

Candidate 的 Managed Patch 如加载带独立 Node 依赖的插件，先在目标主机的该插件目录按 `package-lock.json` 执行 `npm ci --ignore-scripts --legacy-peer-deps --registry=https://registry.npmmirror.com`。当前 `dsh-voice-hub` 的运行时导入链需要锁定的 peer/dev 依赖 `@deepseek-ai/cordis`，不能加 `--omit=dev`。`node_modules/` 已被 Git 忽略，会随 `candidate/dsh/managed` 一起只读挂载，Node 从插件文件所在目录向上解析依赖；不得把 AMD64 主机安装的 `node_modules/` 复制到 ARM64 主机。当前 `security-operations-expert` 的 `dsh-voice-hub` 使用 `sherpa-onnx-node` 原生包，须在每台目标主机的当前 active Experiment Candidate 中安装，并在对应容器内核对完整插件导入、原生模块加载、插件激活和浏览器语音功能；目录存在只表示依赖已放置。只有依赖必须存放在 Candidate 外时，才用 `dsh-dev up --plugin-node-modules PATH` 额外挂载到 `/opt/node_modules`。

`locked-user.patch.yml` 只读覆盖 HOME 级用户 Patch；Web Profile 的 `cordis.patch.yml` 留在实例 HOME 卷中，由 DSH Web 保存当前实例的设置（新版 DSH 的设置写入要求对该文件原子替换）。真正 **0 字节**的 `locked-global.AGENTS.md` 和只含注释的 `locked-bootstrap.env` 分别只读覆盖全局 Agent instructions 与 Boot 环境文件。模型/MCP Endpoint 和凭据只能由调用环境或 Runtime 受控凭据提供，不能由 Candidate 工作区改变。复用实例时须把 Web Profile 设置视为运行状态，而非 Candidate 资产；评估前核对其摘要或使用新实例。

`dsh-dev` 在来源 Managed Patch 和访问设置之后装载 [`runtime-model.patch.yml`](runtime-model.patch.yml)，再装载实例启动时生成的 `model.patch.yml`。数据根 `config/business-model-default.json` 的 schema 1.2 只保存业务智能体统一默认模型；业务可选范围由平台当前 DSH 模型目录中已配置、可路由且非账号登录的模型派生。平台创建或重启实例时，`--model-policy` 投影该范围、所选模型与公开连接配置，并绑定统一默认配置的修订摘要。新实例预选统一默认模型，也可单独选择其他业务可用模型；现有实例继续使用登记的默认模型，未登记默认模型的旧实例须先显式选择。旧 schema 1.0/1.1 只供迁移显示，确认并保存统一默认后才用于新实例。没有平台投影的 `dsh-dev` 直连启动只能使用统一默认模型，且须由当前来源 Patch 或适配器 Patch 明确提供对应模型连接；否则使用平台实例管理或提供当前 `--model-policy`。`dsh-eval` 的普通预检遵循相同判定；新建与编辑草稿使用 `--dry-run --source-check` 只核对来源及 Case，输出的 `preflight_scope` 明确标识未核对模型策略。已用平台策略启动的实例重启仍须提供当前策略。平台投影以所选模型的凭据引用替代来源声明中的模型连接变量要求，来源声明的 MCP 环境要求继续生效。同一业务实例的所有 Session（包括评测 Judge Session）的模型请求均由只读挂载的运行插件按 provider/model 校验；独立归因实例使用自己的模型路由。修改统一默认或实例默认后，实例须重启并核对 `instance.json.model_policy` 才算应用；新 Session 核对默认值。投影不修改 Candidate、已有 Session 或历史 Run，API Key 仅按引用从运行环境传入，不写入 Patch、Compose 或日志。

Web Profile manifest 与本地 module 路径由受控文件和空的 deny-layer 锁定，避免从可写 HOME 装载私有 Plugin。选择旧 `@deepseek-ai/dsh-experimental-schedule-bundle` 的固定 Candidate 在实例目录生成只读兼容 manifest；投影移除已退役的 bundle 引用，由受控适配 Patch 提前补回原生 `tool-schedule`，保持旧 bundle 的根工具集合，并为目标自定义 Preset 补齐 `time-context`。不重复 Schedule 服务和任务界面；原 Guard 继续隐藏子 Agent 的任务工具，原生工具继续拒绝被委派调用。原 manifest 及其摘要记录在实例投影的 `origin.json`，原 Candidate 不变。Web Profile 的初始 MCP seed 始终从原 manifest 同目录读取。已有 HOME 中的 manifest 仅在字节匹配原来源时迁移；不匹配时拒绝覆盖。其他来源仍使用默认 Web Profile。旧版 DSH 使用共享 fallback 卷中的安装链接；新版 DSH 使用原生模块解析，两种路径均须解析到镜像内 `/opt/dsh/`。Runtime 安装 fallback 卷名包含当前镜像构建指纹，升级使用新派生卷并保留旧卷用于回退；它不属于业务 HOME。旧 HOME 中被 deny-layer 隐藏的本地模块不会自动删除。

同一旧 Profile 的 Managed Patch 若仍声明 `persona`、`toolFilter` 前台委派，启动器只替换运行投影中的模块入口，原提示词与工具名单不变。适配器通过原生 include Patch 覆盖子角色 Persona，复用原 Preset 的 Guard 与确认器，在最终 Agent 层应用原白名单；前台桥使用公开 `startActivation(delivery: caller)` 等待结果、取消与清理，保留旧 `foreground` 回执，避免子结果重复通知。原文件与投影摘要记录在 `managed-origin.json`。当前兼容范围仅为已固定的 `spawn`、`enableRunInBackground: false`、`backgroundMode: one-shot` 配置，其他退役配置明确失败。

旧 Persona 的 `{{cwd}}` 由公共适配插件映射到原生 `workingDirectory.get(agent.session)`，反映当前已提交工作目录，不修改 Candidate 模板。

启动 `web` Profile 并叠加来源声明的 Managed Patch。锁定官方 Loader 在本 Node 镜像的无 internal-loader 路径会从 `/opt/dsh/vendor/loader` 相对查找 bare package，因此仅主 `dsh` 服务使用精确向量 `node --expose-internals /opt/dsh/apps/cli/lib/bin.js`；`home-init` 与装载探针保持普通 `node`。隔离、无 Candidate Managed Patch 的官方 base+web 技术预检可运行至少 15 秒；这不表示 Candidate 业务启动、MCP 或模型连接通过。

`--expose-internals` 让同一主进程中已加载的 JavaScript Plugin 可访问 Node `internal/*`，不是安全控制。改变 DSH 官方提交、Node 镜像/版本、Bundle 或候选 JS Plugin 时，必须重新审查该旗标与模块解析；若官方 Loader 修复，应移除旗标并重做容器验收。

`verification.compose.yaml` 无宿主机端口发布、Docker socket、仓库根目录、历史归档或评估目录挂载；根文件系统只读，容器用户为 UID/GID 1000，去除能力并设置 `no-new-privileges`。`DSH_HOME` 存放 Session、settings、附件及受控 Runtime 凭据，与 Harness 工作区分开。

```bash
docker compose -f runtime/adapters/dsh-container/verification.compose.yaml config --quiet
```

直接运行 Compose 只用于模板级检查；启动业务实例应使用 `dsh-dev up --source`，由它从选定版本的 `candidate/harness.yaml` 解析 Patch、三棵卷及可透传环境变量，并从 `source.lock.json` 解析标准镜像，为每个实例使用独立 HOME。MCP 缺失凭据不阻塞实例启动。Compose 的变量覆盖不是独立的来源授权接口，不能仅靠替换路径后宣称完成另一 Agent 的装载验收。

实际 Agent 需要模型与 MCP 端点时，由调用环境提供相应配置。环境变量按名称传入，本适配器不读取或展开凭据值到 Compose。平台和实例凭据可以使用 Agent 的实例专用仓库文件；LLM API Key 只能来自被 Git 忽略的 `*.llm-api-key` 文件或其他受控运行时来源，不得进入 Git 历史或远端。不得把 `docker compose config` 的完整展开结果、启动 Token URL 或原始日志作为公开研究证据。MCP 连接或凭据缺失仅影响对应工具，实例仍可启动和处理其他交互；工具调用时报告实际依赖缺口。

`DSH_PERMISSION_MODE=read-only` 是官方 base Profile 的新 Session 进程后备预设；Web 中持久化的 General Settings 仍可能影响后续 Session，因此不能只凭该变量推断实际状态。三棵 Candidate 资产同时使用 Docker `read_only` bind mount。比较变更前后行为时，应在宿主核对 Git diff 和资产摘要，再用新的评测容器与 Session 重建加载。

官方 Web 默认只绑定容器内 `127.0.0.1`，基础 Compose 不发布宿主端口。需要浏览器访问时使用 `dsh-dev` 生成的本地 host-network 实例；容器启动或配置展开仍不能替代 `PA-08` 的实际 Web 交互。

业务实例的局域网监听与 Web 设置由适配层 Patch 统一启用，访问规则见下文[实例访问规则](#实例访问规则)。锁定 rc.2 已原生支持浏览器 Host 设置持久化；不再修改 Runtime 源码或注入旧版设置标记。升级后仍需验证模型设置与插件表单保存、重启回读及浏览器行为。rc.2 原生要求绑定具体 IP；站点适配器仅为既有明确配置的 `0.0.0.0` 提供兼容，保持 LAN 与 loopback 入口可达，其他地址和配置继续执行原生校验。未来统一业务网关采用具体私网地址后移除此兼容。

仅在受控反向代理保留外部 `Host`、后端仍监听本机回环时，`dsh-dev up` 可显式加 `--trusted-host HOST[:PORT]` 让 DSH 接受该代理地址；这不提供用户认证，也不允许把启动令牌写进菜单 URL。EXP-007 门户接入的实际拓扑、验证和限制见数据工作区 `agents/security-operations-expert/docs/security-operations-expert门户联调记录.md`。

## 构建镜像

```bash
bash runtime/adapters/dsh-container/build-image.sh --build-network host
```

构建期 APT 默认走 `http://mirrors.tuna.tsinghua.edu.cn/debian`，security 保持 `http://deb.debian.org/debian-security`；npm/pnpm 与 corepack 走 `https://registry.npmmirror.com`。两者都不需要调用方额外加参数；只有 TUNA 不可达时，才用 `--apt-mirror http://deb.debian.org/debian` 显式回退到官方主源。

换源不放松校验：APT 仍由 `debian-archive-keyring` 校验 Release/InRelease 签名与 `Valid-Until`，依赖仍按 `pnpm-lock.yaml` 的完整性摘要校验。实际使用的源写入该次构建证据。

在目标主机用当前 Agent 的 active Experiment ID 查询平台并构建一次标准镜像；同一主机的其他 Agent 共用它。原生部署时，`uname -m` 与 Docker server 的 Architecture 应对应同一种架构。构建后核对 Image ID、平台和构建指纹，再启动实例：

```bash
python3 runtime/adapters/dsh-container/source_contract.py \
  --source experiment:<experiment-id> --field image.platform
bash runtime/adapters/dsh-container/build-image.sh --source <experiment-id>
hep_image_tag="$(python3 runtime/adapters/dsh-container/source_contract.py \
  --source experiment:<experiment-id> --field image.local_image_tag)"
docker image inspect "$hep_image_tag" --format \
  '{{.Os}}/{{.Architecture}} {{.Id}} {{index .Config.Labels "org.ai-agent-harness.dsh.image-build-fingerprint"}}'
```

启动器还会核对镜像身份。现有 AMD64 本地镜像的旧构建指纹不会自动升级；更换源码锁或适配器构建输入后先重新构建，已有实例按实际需要使用 `up --replace` 重新装载并核对 HOME。目标主机应分别检查标准镜像中的 DSH CLI 和 Chromium 可执行、当前 active Experiment 的 Candidate 装载、插件激活及新 Session；只有文件存在、`docker image inspect` 成功或容器处于 running 状态不能证明业务可用。跨架构搬运的原生依赖即使目录存在也不等于可装载。

当前 `security-operations-expert` 的 `dsh-voice-hub` 安装示例（`<experiment-id>` 必须取该 Agent 的当前 active Experiment）：

```bash
cd "$HARNESS_ASSET_ROOT/evolution/experiments/<experiment-id>/candidate/dsh/managed/dsh-voice-hub"
npm ci --ignore-scripts --legacy-peer-deps --registry=https://registry.npmmirror.com
node -e "require('sherpa-onnx-node')"
```

宿主机导入成功后，还要在该 Agent 的运行实例中验证完整插件及原生模块都可加载：

```bash
docker exec <instance-name> node -e \
  "import('file:///opt/dsh-managed/dsh-voice-hub/lib/index.js').then(() => console.log('voice plugin import ok'))"
docker exec -w /opt/dsh-managed/dsh-voice-hub <instance-name> \
  node -e "require('sherpa-onnx-node')"
```

随后核对 `/assistant/voice-mode/config` 返回 JSON 200、DSH 插件界面及目标浏览器的实际语音行为。局域网麦克风访问还受下文[实例访问规则](#实例访问规则)的 HTTPS 条件约束。若模型、MCP 或语音服务端点尚不可用，分别记录对应限制，不把技术装载写成任务效果通过。

## 评测实例与本地装载核验

`dsh-dev` 是宿主侧实例启动器（只依赖 Python 3 标准库、Docker CLI 和 Compose），把受控 Compose 渲染成仓库外实例。新实例只支持 `--mode eval`（内部模式 `verification`）：`session_preset` 与 `target_preset` 都来自所选来源，注册工作区固定为 `/work/harness/workspace`，三棵 Candidate 资产全部只读，且不挂载判分材料。

目标 Preset 由选定版本 `candidate/harness.yaml` 的 `loadable_assets.preset_id` 与可选 `preset_file` 指定，适配层不内联业务 Agent 名。Harness 创建或修改由宿主开发会话通过项目技能完成，再启动新的评测实例观察结果。

```bash
python3 runtime/adapters/dsh-container/dsh-dev init test01
python3 runtime/adapters/dsh-container/dsh-dev up --source experiment:EXP-security-operations-expert-024-rad80a907c628 --mode eval --dry-run
python3 runtime/adapters/dsh-container/dsh-dev up --source experiment:EXP-security-operations-expert-024-rad80a907c628 --mode eval
python3 runtime/adapters/dsh-container/dsh-dev ps
python3 runtime/adapters/dsh-container/dsh-dev url security-operations-expert-eval --non-interactive   # 交互终端可省略该旗标
python3 runtime/adapters/dsh-container/dsh-dev logs security-operations-expert-eval --tail 200
python3 runtime/adapters/dsh-container/dsh-dev down security-operations-expert-eval
```

`init <agent-id>` 创建最小 Agent、`EXP-<agent-id>-001-r<12位随机十六进制>` Candidate，包含该版本独立的装载声明；已有 Agent 或 Experiment 时拒绝覆盖。旧编号 Experiment 继续可用。它只创建研究资产，不启动实例、不执行 Evaluation，也不创建 Research Release。

`--source` 和 `--mode` 始终由用户显式选择；缺失或无值时命令会列出当前可用值并以用法错误退出。`--name` 默认为 `<agent-id>-eval`。新业务智能体实例未指定 `--port` 时，在 `18500–28999` 内选第一个未监听且未被有效实例记录占用的端口；区间已满时明确失败，显式指定端口不受默认区间限制。探测包含仅绑定局域网地址的服务。实际启动时，宿主短期文件锁覆盖选端口到确认本容器持有监听，避免不同账户或数据根并发选中同一端口；已有同名实例复用记录端口。`--dry-run` 只给出建议，不预留端口、不写状态、不调用 Docker，也不要求运行时环境变量。

`up` 会先核对镜像标签对应的构建指纹、平台和 Image ID，再执行停旧实例、写状态和启动；Compose 使用 `tag@image-id` 不可变引用。新建或替换后的主 `dsh` 容器名与实例名完全一致，Compose 项目名固定为 `dsh-dev-<实例名>`；`up --dry-run`、`up` 和 `ps` 都直接输出实例名、实际主容器名和项目名，旧实例由 `ps` 输出其现有主容器名并标记 `needs_migration`。它仍不只看 `docker compose up -d` 的退出码：命令返回 0 之后还要确认 `dsh` 服务真的在运行（`home-init` 是一次性服务，正常结束不算失败），否则报告失败或 `dsh_running: "unknown"` 并以非零退出码结束。成功时 stdout 只输出一个 JSON 结果，其中包含 `image_id`、`image_ref` 和 `image_build_fingerprint`；进度、提示和错误输出到 stderr，失败时 stdout 保持为空。`up --replace` 的成功 JSON 在 `replaced.stop` 中包含完整停止结果。

`ps`、`logs`、`down` 从实例状态文件重建 Compose 所需环境；`ps` 默认只列出运行中的实例，`ps --all` 才包含其他状态并标出 `needs_migration`。历史 `authoring` 实例仍可查询日志和停止，但新建或替换时只接受 `eval`。挂载内容变化不会自动重启进程，使用 `up --replace` 或先 `down` 再同名 `up` 重载。`down` 同时核对 Compose 退出码、实际容器状态和 HOME 卷。

`stopped` 表示仍存在已停止的 DSH 容器；`absent` 表示 Docker 查询成功，但仅有本地登记、没有 DSH 容器。`down` 移除容器后保留登记和 HOME，因此随后通常为 `absent`；Docker 查询失败则为 `unknown`，不能推断为已停止。`delete` 可删除 `stopped` 或 `absent` 实例，执行前重新核对该实例的 Docker 状态，移除容器和登记并保留 HOME 卷及研究记录。

新实例的 HOME 使用上述目录的 bind 挂载；原生 Session、附件和 Web MCP 设置都保留在该 HOME。历史登记仍使用原 named volume，普通 `up --replace` 不会将其换成空 HOME。迁移时先停止实例并备份，再完整复制旧 HOME 到目标登记目录的 `dsh-home/`，校验文件与权限后执行：

```bash
/usr/bin/python3 runtime/adapters/dsh-container/dsh-dev up \
  --source <原来源> --mode eval --name <原实例名> --replace --migrate-home
```

`--migrate-home` 拒绝缺失或空目录，只由 `dsh-dev` 更新 `instance.json` 和 Compose；旧数据卷保留以便回退。`delete` 仅删除已停止实例的容器与登记文件，保留同目录下的 `dsh-home/` 和其中的原生 MCP 配置。HOME 数据属于需要备份的持久化数据，不能当作构建缓存清理。

两份启动器设计方案保留为历史设计记录；当前行为以本页、CLI `--help` 和测试为准。

## 受管评测

`dsh-eval` 从 Agent 的 `evaluation.md` 读取业务 Case 的名称、用户输入和预期，并复用 `dsh-dev` 与 `run_record.py` 完成一次可封存评测。新 Run 的 `inputs.lock.json` 分别记录 `program_origin`（程序提交与 dirty 状态）和 `asset_origin`（数据提交、dirty 状态、workspace ID 与 Candidate 摘要）；既有 `git_version` 继续表示资产来源。历史 Run 不重写，摘要与 dirty 标记本身不等于可还原的源文件包。默认执行器通过 DSH Runtime Session API 运行业务 Case；显式选择 `browser` 时，才使用镜像中已有的 Playwright 依赖做 UI 冒烟：

本地 TypeScript 研究入口直接读取现有来源与 Run，不另存可编辑副本。`edit` 调用编辑器修改所选 Experiment 的 `candidate/`；`run` 默认对显式 Case 启用 AI 证据复核，完成后输出封存状态、工具调用与证据路径。真实业务判断仍需核对原始回答及工具记录。

```bash
node runtime/adapters/dsh-container/research-tool.mts context --source experiment:EXP-security-operations-expert-024-rad80a907c628
node runtime/adapters/dsh-container/research-tool.mts edit --source experiment:EXP-security-operations-expert-024-rad80a907c628 --file dsh/workspace/.agents/skills/security-inspection/SKILL.md
node runtime/adapters/dsh-container/research-tool.mts run --source experiment:EXP-security-operations-expert-024-rad80a907c628 --case U-INS-001 --case U-INS-002 --case U-INS-007 --dry-run
node runtime/adapters/dsh-container/research-tool.mts run --source experiment:EXP-security-operations-expert-024-rad80a907c628 --case U-INS-001 --case U-INS-002 --case U-INS-007 --compare-to <baseline-run-id>
node runtime/adapters/dsh-container/research-tool.mts review --left <baseline-run-id> --right <candidate-run-id>
node runtime/adapters/dsh-container/research-tool.mts instance --source experiment:EXP-security-operations-expert-024-rad80a907c628
```

`context --run <run-id> [--case <case-id>]` 显示冻结口径、当前口径、已注册工具和实际调用；`instance --restart --name <已存在且属于该来源的实例名>` 重启后重新读取容器镜像与只读挂载。`--review ai|none` 也可直接传给 `dsh-eval`；API 通道的 `full` 默认 `ai`，其他选择默认 `none`。浏览器通道仅支持 `none`。

研究者可用 `run_record.py index --agent <agent-id>` 列出 Experiment 与 Run，使用 `show --run <run-id> [--case <case-id>]` 对照当前与冻结 Case、结果和证据，使用 `compare --left <run-id> --right <run-id> [--case <case-id>]` 查看共同 Case 的观察差异及归因限制。三个查询命令只读取现有文件。`dsh-eval --compare-to <run-id>` 或 `run_record.py init --compare-to <run-id>` 将已封存的同 Agent Run 锁入新 Run；封存时在新报告中生成“与之前版本的对比”，旧 Run 保持不变。不同模型仍可做观察性对照；`comparable` 只表示存在共同 Case 的两侧结果，`causal_comparable` 表示记录的条件未见差异，两者都不证明 Harness 单独造成效果变化。需核对冻结 Case、实际路由、镜像、执行器和 Git 来源，硬件与资源未测时报告为“未记录”。`dsh-eval --model <id>` 只锁定预期模型标识，不切换 Runtime 模型。`--model-policy <绝对路径>` 将非秘密模型策略用于预检和实例启动，连接凭据仍由运行环境提供；同时指定 `--model` 时，模型 ID 必须与策略默认值一致。

```bash
python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:EXP-security-operations-expert-024-rad80a907c628 --mode fast --dry-run
python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:EXP-security-operations-expert-024-rad80a907c628 --mode fast
python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:EXP-security-operations-expert-024-rad80a907c628 --mode full --dry-run
python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:EXP-security-operations-expert-024-rad80a907c628 --executor browser --case U-INS-001
python3 runtime/adapters/dsh-container/dsh-eval \
  --source experiment:EXP-security-operations-expert-024-rad80a907c628 --case U-QA-012 --case U-QA-013 \
  --compare-to <baseline-run-id>
```

默认 `--mode fast` 执行标记了 `**评估档位：** \`fast\`` 的业务 Case；`--mode full` 执行全部 Case。没有 fast 标记时默认档位明确报错。`--case` 可重复并支持大小写敏感的 shell 风格通配符，一旦出现就覆盖 `--mode`；结果按 `evaluation.md` 顺序去重，为避免 shell 提前展开应给通配符加引号。`--dry-run` 输出请求档位、实际选择方式和 Case 列表。这里的 `--mode` 是评测范围，和 `dsh-dev --mode eval` 的容器运行模式不同。非 `--dry-run` 执行会先校验仓库和 Experiment，再创建独立评测实例。每个 Case 使用新的目标 Session，多轮输入在该 Session 内依次发送；API 和浏览器执行器都导出回答及同一 Session 的工具事件。API 通道用独立的无工具评审 Session 对照输入、预期、回答和工具证据给出语义结论；浏览器通道只检查页面、会话身份、消息发送及回答显示，业务结论保持 `inconclusive`。

启用 AI 复核后，适配层在逐 Case 评审后，再启动使用 `scenario-analysis` Preset 的独立 DSH 实例，只把当前 Run 以只读方式挂载到 `/work/evaluation-run`；被测 Candidate 的 workspace、Preset、managed patch、MCP、Skill 和 delegate 均不进入归因实例。每个已选场景使用一个 Session，通过 `read`、`grep` 和 `glob` 核对 Run 证据与锁定的 Harness，并显式选择目标 Run 实际使用的同一模型路由；当前只支持内置 `deepseek-official` 路由，缺失、混用或不支持的路由失败关闭。为避开 `read` 的行数、单行和字节上限，适配层在 Run 内生成带原文件路径、字节数和 SHA-256 的 JSON/JSONL 语义无损场景包，并对重复的大型工具结果按内容摘要引用；原文件仍是事实源，报告也只引用原文件。执行器要求每次工具调用都有成功结果，并验证所有必读分片的每一行均被读取，漏读、读取失败或路由漂移都会使复核失败。缺口可以同时引用支持 Case 与反例 Case 的原始证据；空 `tools.jsonl` 是“未调用工具”的有效证据，其他材料证据必须非空。`evaluation-judge` 与 `scenario-analysis` 都是评测适配层 Harness，不属于被测 Candidate；`.agents/skills/research-eval` 只指导仓库研发流程，不会被 DSH 归因实例装载。技术装载、合同和工具链检查由运行前的项目与 Experiment 校验承担，不是业务 Case。认证 URL 只经进程标准输入交给执行器，不写入 Run 或普通输出；无论成功、失败或中断都尝试停止实例。

API 通道退出码 `0` 表示锁定 Case 均得到 `passed`；`1` 表示运行已完整封存但至少一个语义结论为 `failed` 或 `inconclusive`。浏览器通道在所选 Case 均完成 UI 冒烟时返回 `0`，业务 `verdict` 仍为 `inconclusive`。退出码 `2` 表示参数、环境或执行基础设施失败。基础设施失败导致未执行的 Case 记为 `execution_status=error`；中断后未开始的 Case 记为 `execution_status=skipped`，两者的 `verdict` 均为 `inconclusive`。每次封存保留 `summary.json`、逐项事实 `results.jsonl`、完整场景目录与选择方式，以及只读的 `analysis.json` 和 `report.md`。报告按场景展示去重 Case 的覆盖、失败、无法判定和未执行数；归因只给出可证伪假设，不改变 Case 原判定。启用 AI 复核时证据复核不完整会使 `review_status` 为 `failed`，Run 失败封存；未启用时只生成确定性场景覆盖，不启动归因 Session。非 `--dry-run` 的 stdout 只输出一个不含凭据的 JSON，字段为 `run_id`、`experiment_id`、`executor`、`verdict`、`cases`、`review_status`、`reviewed_cases`、`summary`、`report` 和 `instance_stopped`。

**普通研究实例手工打开 Web 时，先选定 Candidate 工作区。** 容器的 `working_dir` 只是进程工作目录，不等于 DSH 已登记的工作区。API 执行器使用 DSH 原生 `workspace/create` 登记；普通实例在浏览器中选择 `/work/harness/workspace` 的步骤如下：

1. 在 Web 界面点击“选择工作区”；
2. 在“选择工作区目录”对话框点“编辑路径”，粘贴 `/work/harness/workspace`（或从“主目录”逐级进入）；
3. 点“打开”，会话即在该工作区创建，随后可直接对话。

该注册写入本实例 DSH_HOME 数据卷并跨重启保留；换用新的实例名等于新的 HOME 卷，需要重新选择一次。普通实例的 `up --dry-run` 输出与真正 `up` 的 stderr 提示会带上该路径与步骤，以 `workspace_to_register` 为准。受管业务实例由业务 Runtime 在启动时调用 DSH 原生 `workspaceRegistry.create` 登记固定工作区，浏览器自动选中，无需选择工作区或预设；工作区目录选择接口仍不开放。

### 实例访问规则

受管即时业务模式与既有研究模式分别使用下述入口，不能共用 HOME 或凭一次页面访问推断隔离完成。

#### 受管即时业务模式

`dsh-dev up` 显式增加 `--business-control <启动配置的绝对路径>`，并选择固定来源、新实例名和独立 HOME。启动配置包含 `assetRoot`、`coordinatorOrigin`，可选 `pluginRoot`；发布模式还要求 `sharedSecretFile`，开发模式不校验或挂载签名密钥；它只引用实际数据根、专用签名密钥文件、容器可达的协调器来源和已构建插件，不复制访问策略或 MCP 配置。`coordinatorOrigin` 不能使用宿主回环地址。启动前先构建 `platform/plugin`，由管理平台装载统一网关；业务访问规则及 Agent 的可信来源摘要唯一维护在数据根 `config/business-access.json`，合同见[业务访问规范](../../../docs/platform-design/20_业务访问与运行控制插件开发规范.md)。

这一模式复用标准 Runtime 镜像，将业务插件和资产只读装载到新实例，使用独立 bridge 网络；宿主映射端口只监听 `127.0.0.1`，原生 HTTP/WS 接入核对网关实例上下文，发布模式另须签名。`dsh-dev url` 返回统一网关的 `/agents/<agent-id>/` 地址；用户登录、智能体 HMAC 认证、来源信任和访问策略分别核验。普通同 HOME 重启保留持久实例代次和会话归属，发布模式重新建立签名握手；删除登记后同名新建不能继承旧认证证据。无需认证的开发调试实例可以复用删除登记后保留的普通 HOME 目录，保留共享会话并生成新的实例代次；认证或发布实例仍要求新的独立 HOME，符号链接不可作为 HOME。平台创建预览与执行将访问方式和身份阶段通过 `--business-access-mode`、`--business-identity-mode` 成对传入启动器，在网关登记写入前完成 HOME 校验；已有实例的启动与重启只沿用登记设置。

不能同时使用 `--migrate-home`、归因模式、`--lan-access` 或 `--unsafe-no-auth`，也不能把既有研究实例原地切换为业务控制模式。原生定时服务、工具与页面已开放，当前检测、防护闭环仍只覆盖即时任务；到期消息与业务执行须分别核对回执。定时任务的当前边界见[实施路线](../../../docs/platform-design/05_实施路线与迭代计划.md#首期定时任务边界与影响)。

#### 既有研究模式

未使用 `--business-control` 的既有研究实例继续由 `dsh-dev up` 的共用预检入口采用以下设置：Web 监听 `0.0.0.0`，允许局域网远程访问；关闭 Web/API 的 Token 与 Host/Origin 校验；跳过 Web 内测声明弹窗。命令行、平台创建/启动/重启、研究工具重启及评测创建实例均使用这个入口。`up --dry-run` 的计划与实际写入的配置使用同一规则；`--lan-access`、`--unsafe-no-auth`、`--skip-testing-notice` 保留为显式标记，不再是研究实例的可选访问模式。

已有实例再次启动时自动应用新规则，不继承旧访问设置；运行中的实例需执行重启或 `up --replace` 才会重新加载，HOME 卷及记录端口保持不变。专用归因工作进程不装载业务智能体，它读取只读 Run 进行内部评审，继续使用回环监听和 Token 认证。

`dsh-dev url` 核验实例可访问后返回不带 Token 的本机 `/assistant/` 地址。平台表格的“访问 DSH Web”入口在新标签页打开它，并把局域网实例的主机名替换为当前平台主机名，保留站点路径；停止、无容器或未记录端口的实例需先启动。锁定版 DSH 的 `--host 0.0.0.0` 会被命令行拒绝，监听通过适配层 Patch 生效。免认证意味着能访问该端口的用户可操作整个共享 DSH 实例；平台登录不会隔离容器内的访问。

两套站点的基址只在数据工作区 `config/sites.json` 维护。平台和容器加载同一 TypeScript 适配器，业务容器只读挂载其 ESM 制品到 `/opt/dsh-web`。启动预检会构建适配器；首次需要 Node.js、pnpm 和依赖下载，之后复用锁定依赖。平台通过 `HARNESS_SITES_CONFIG` 读取该文件；业务容器将该文件单独只读挂载到 `/opt/harness-config/sites.json`，不会挂载整个数据根。修改基址后重启平台并对容器执行 `up --replace`；HOME 保留。基址变化通过原生 HTTP、WebSocket 和静态资源注册边界生效，不使用反向代理，不重建标准 Runtime 镜像。原生 Vite 相对资源保持不变；独立插件的浏览器请求、Worker 和 Worklet 目标在客户端资源出口统一转换，外部服务地址不变。转换资源不使用 immutable 缓存，修改后的代码不保留旧 sourcemap 引用。

根页面 `/` 与缺少尾斜杠的基址返回 `302` 并保留查询参数；旧根路径的 API、MCP、插件资源和连接入口返回失败，不重定向协议请求。容器中的 MCP 管理及 MCP 端点随站点基址迁移，现有摸底插件暂时保留；以后由平台统一配置的功能不在本次实现范围。

实例配置与 `instance.json` 默认写在 `<数据根>/.local/instances/<name>/`。显式覆盖按 `HARNESS_INSTANCE_STATE_ROOT`、`$XDG_STATE_HOME/dsh-dev` 的顺序优先；未设置覆盖时始终使用数据工作区。实例状态记录来源、模式、挂载路径、环境变量**名称**、镜像身份及 `web_base_path` 等非秘密元数据，不含 Token。渲染保留只读根文件系统、UID/GID 1000、能力裁剪和无端口发布，只把主 `dsh` 服务切到 host 网络。尚未重启的历史实例按登记的旧基址继续运维；历史 Token 入口只读取本次进程启动后的日志并做 Token→Cookie→站点页面探针。非交互标准输出必须显式加 `--non-interactive`，不把 Token 写进状态文件、普通日志或证据。API 评测执行器支持新站点地址与历史 Token 握手，并保留 URL 中的站点路径。

需要浏览器麦克风的插件在局域网使用时，页面还须由浏览器认可的 HTTPS 入口提供；局域网 IP 上的纯 HTTP 页面没有麦克风所需的安全上下文。本机 `localhost` 页面可以直接使用麦克风。

MCP 是可选的外部服务。连接失败只影响相应工具发现与调用，不阻塞实例启动、普通聊天或其他可用工具。当前来源默认取智能体 manifest 的 `active_experiment`；需要复现历史来源时，先从固定数据提交恢复到独立数据目录，再显式指定来源，不向当前来源目录重新登记旧版本。

历史装载证据见 [2026-09-18 实机记录](https://github.com/wr5912/harness-engineering-platform-data/blob/9afc8fd0047367deb9df5b51595f101835359044/evolution/experiments/EXP-security-operations-expert-001/evaluation/evidence/dsh-dev-live-load-20260918.json)。该记录只证明当时的技术装载，不代表当前业务验收。

在上述装载核验开始前，脚本会核对镜像构建指纹、平台和 Image ID，并把 Compose 固定到 `tag@image-id`；无 OCI 指纹 label 或指纹过期的本地镜像会直接拒绝。

## 局部加载核验与变更回执

镜像已经构建、候选资产未并发变化时，可以执行：

```bash
bash runtime/adapters/dsh-container/verify-load.sh verification
# 其他已登记来源：verify-load.sh verification --source <experiment-id>
```

适配层脚本不烘焙进镜像：`prepare-verification-home.mjs`、`verify-load.mjs`、`tree-digest.mjs` 由 Compose 只读挂载到 `/opt/dsh-adapter`。脚本先比对宿主与容器脚本 SHA-256，再比对三棵 Candidate 资产树，并断言 `/work/reference` 与未声明的 `/work/eval-input` 不存在；同时核对挂载模式、HOME 卷、受控 Patch、零字节全局指令、注释 `.env`、module deny-layer、镜像内模块解析与 DSH 配置标识。它只证明挂载身份、模块解析和配置组合，不证明 Plugin 激活、MCP 连接、模型行为或 Research Release 复现。

取得一棵精确资产树摘要时，使用 `mutation-receipt.py digest <路径>`。

局部装载比较前可物化三棵 Candidate 挂载树的实际字节（含未提交文件），并在只读容器装载前复核摘要：

```bash
python3 runtime/adapters/dsh-container/mutation-receipt.py freeze
# 将上一步打印的路径作为 SNAPSHOT_DIR
bash runtime/adapters/dsh-container/verify-load.sh verification --frozen SNAPSHOT_DIR
```

副本位于所选 Experiment 的 `snapshots/frozen-sources/fr-<UUIDv4>/`；`snapshot.json` 记录三树文件、目录权限摘要和来源，`frozen-digest` 会核对副本字节与权限。`restore SNAPSHOT_DIR` 仅在 Candidate 根目录不存在时恢复三棵挂载树，绝不覆盖现有工作树。这只是一次局部装载探针使用的可还原挂载源，不是项目 Baseline 或 Research Release；长期研究版本仍由 Git 保存。

整套源码研究快照（`snapshots/research/`）的创建与复核已退役：它与 Git 重复保存同一份内容，并要求跨环境重现宿主机完整 POSIX 权限。历史内容按 `evolution/experiments/<id>/snapshots/README.md` 的映射从 Git 提交恢复。

未来若实现 `release:<id>`，启动器应直接装载具体、不可变的 Research Release，并核对清单摘要与实际 DSH 身份。当前没有 Research Release，也没有对应解析入口，不能把 Candidate 装载写成 Release 复现完成。
