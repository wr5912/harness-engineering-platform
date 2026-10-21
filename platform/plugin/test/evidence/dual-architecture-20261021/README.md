# 双架构部署整改：AMD64 本机验证

2026-10-21 在 Linux `x86_64` 宿主执行；Docker server 报 `linux/amd64`。使用程序分支 `fix/PLATFORM-dual-architecture-deployment`、数据仓库提交 `69ff154df77e7d3da38f208a5f0b2f8cc0d8e475` 的独立完整克隆。运行数据、凭据和新 Session 仅进入隔离克隆的 `.local/`；没有替换现有 3090/3091 平台或业务实例。程序、数据仓库均未提交或推送本次改动。

## 本机结果

- 来源解析将 `x86_64` 映射到 `linux/amd64`；单测覆盖 `amd64`、`X86_64`、`aarch64`、`arm64` 及其他架构拒绝。来源锁保留相同官方 DSH commit/tree，镜像标签与构建指纹包含本机平台。
- `docker buildx imagetools inspect` 确认锁定的 `node:24-bookworm-slim` OCI index 同时列出 `linux/amd64` 和 `linux/arm64/v8`；这只证明基础镜像索引可选 ARM64，不能代替完整 ARM64 构建和运行。
- [镜像构建记录](image-build-amd64.json)：标准 Runtime 镜像为 `ai-agent-harness/dsh:687f282e8-amd64-4e0a7aaa5c8f`，Image ID `sha256:ba2ec964ef463b2d0f8f55ecca75e4e97751d06f5267ba0c9c1dc33f5ed20952`，平台 `linux/amd64`，DSH CLI `0.2.1-rc.2`；构建脚本的 APT 签名预检、Image ID/平台/指纹核对和 CLI 检查均通过。镜像内 Chromium 以 headless 模式打开 `about:blank` 并正常退出。构建使用 `--build-network host`；最终脚本运行用同提交同 tree 的本地 DSH Git 仓库作网络缓存，构建脚本仍核对锁定来源和摘要。未获得 Registry digest，也没有推送镜像。
- 隔离平台运行 `platform/dsh-platform prepare`、`start`；密码登录返回 303，认证后 `/hep/` 返回包含 `__DSH_BOOT__` 的页面，原生 `session/create` 与 `session/list` 能创建并回读新 Session。实际模型请求返回提供方 `Insufficient Balance`，因此没有把模型回复或平台业务操作记为通过。平台进程已停止，测试端口 31977 已释放。
- 六个 active Agent 的 `dsh-dev up --dry-run` 都解析到同一标准镜像；以下实例在隔离克隆内分别完成启动、`/assistant/` HTTP 200、新 Session 的创建或持久回读、停止并保留 HOME：

| Agent | active 来源 | 端口 | 结果 |
|---|---|---:|---|
| `test01` | `EXP-test01-002` | 31980 | 新建并回读 Session |
| `autonomous-training-researcher` | `EXP-autonomous-training-researcher-001-redf6be6240bf` | 31981 | 新建并回读 Session |
| `daily-inspection-assistant` | `EXP-daily-inspection-assistant-002-r9eba480e9d2a` | 31982 | 新建并回读 Session |
| `inspection-delivery-demo` | `EXP-inspection-delivery-demo-001-rf841e4415364` | 31983 | 新建并回读 Session |
| `multi-step-research-analyst` | `EXP-multi-step-research-analyst-001-r97fa04b7c613` | 31984 | 新建并回读 Session |
| `security-operations-expert` | `EXP-security-operations-expert-021-rdd331f9f2e30` | 31985 | 首次 RPC 在 15 秒客户端超时后服务端已保存 Session；重启后回读成功 |

前四项的镜像、页面、Session 与停止结果见[实例记录](agent-smoke-amd64.json)；安全运营 Session 的超时与回读见[原记录](agent-smoke-amd64.json)和[复验](security-session-recheck-amd64.json)；`test01` 的实例与持久 Session 见[单独记录](test01-amd64.json)。所有测试实例最终均已停止。

安全运营语音插件先按旧说明执行 `npm ci --omit=dev --ignore-scripts --legacy-peer-deps`：`sherpa-onnx-node` 原生模块可加载，但完整插件缺少锁定的 `@deepseek-ai/cordis`，`/assistant/voice-mode/config` 返回 404，见[首次路由记录](security-voice-before-amd64.json)。改为 `npm ci --ignore-scripts --legacy-peer-deps` 后，容器内完整插件和原生模块均可导入；重启实例后该路由返回 JSON 200，见[复验记录](security-voice-after-amd64.json)。部署说明已同步修正。此项只证明插件装载与配置入口，未测试麦克风、ASR/TTS 外部服务或语音业务效果。

适配器来源与实例测试 166 项、平台智能体接口测试 49 项通过；隔离数据仓库合同校验无错误或警告。评测驱动测试夹具补齐统一默认模型后，`DshEvalTests` 的 28 项中 26 项通过，2 项失败：固定的 fast Case 预期列表未包含当前数据仓库已有的 4 项资产告警 Case；此差异与架构选择无关，本轮未改动业务评测口径。完整业务评测不据此宣称通过。

## 验证边界

容器和平台的页面及新 Session 验证不等于模型回复或各 Agent 的业务任务通过。当前数据克隆没有可完成模型请求的余额；训练任务的远端算力及真实外部 SOC/语音服务也未在本轮验证。`PA-05/06/12` 继续为部分验证。

ARM64 主机尚未取得实机运行证据。需要在所述 Ubuntu 24.04.4 `aarch64` 主机按[部署说明](../../../../../README.md#amd64-与-arm64-主机部署)原生安装平台与依赖、完整克隆数据仓库、重新安装 Candidate 原生依赖并构建 ARM64 标准镜像；确认 `uname -m` 与 Docker server 架构一致，再复验平台登录、新 Session、六个 active Agent、Chromium 和安全运营语音插件。只有这些检查完成才能记录 ARM64 实机通过。
