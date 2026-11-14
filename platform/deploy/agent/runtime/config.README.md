# 独立智能体配置

主机须已安装 Docker Engine 和 Compose 插件。解压后在包目录运行 `./standalone_agent_launcher install`，或直接运行 `./standalone_agent_launcher start`；两者都会按需导入 `images/dsh-runtime.tar`。完整启停、维护及 SDK 用法见 `./standalone_agent_launcher help` 和 `./standalone_agent_launcher <命令> --help`。

`deployment.env` 保存端口、访问主机、运行用户和容器项目名。同一主机部署多个 Web 副本时，分别设置 `AGENT_PORT`；容器项目名默认按安装路径区分，也可用 `COMPOSE_PROJECT_NAME` 指定。`compose.yaml` 使用标准镜像，保持 HOME 可写；通常无需修改。

业务 Harness 的 `dsh/workspace/deployment.env.example` 会追加到 `deployment.env`，用于配置通知订阅等公开连接参数。此模板只保存非敏感默认值；凭据通过 `./standalone_agent_launcher configure` 设置。修改环境配置后运行 `./standalone_agent_launcher restart`。

标准镜像不内置代理。可在 `deployment.env` 或包根 `.env` 中设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（兼容小写），修改后重启。默认 bridge 网络连接宿主机代理应使用 `http://host.docker.internal:7897`，代理需监听容器可达的地址；使用 host 网络或容器内代理时才用 `http://127.0.0.1:7897`。`NO_PROXY` 中加入模型及 MCP 的内网地址可让这些请求直连。

默认 Harness 为包内 `harness/`，保留 `harness.yaml`、`dsh/` 和版本声明的 SDK 资产。可在启动时指定 `--harness-root /绝对路径`，或设置 `AGENT_HARNESS_ROOT`；所选目录必须有 `harness.yaml` 和原生 `dsh/`，Web、SDK 及本地工具使用同一来源。资产更新工具只更新包内、未被现场修改的 Harness，不覆盖外部目录。

`seed/standalone.json` 是首次运行的模型与 MCP 配置种子；`seed/environment.llm-api-key` 是环境键到字符串值的 JSON，仅保存模型等连接凭据。包可能含凭据，应作为私有文件传递。初始化后，修改种子不会覆盖已保存配置。

网络安全运营专家的威胁研判子智能体和取证后推理共用 `deployment.env` 中的模型选择：

```dotenv
THREAT_ANALYSIS_MODEL_PROVIDER=local-qwen
THREAT_ANALYSIS_MODEL=Qwen3.8-27B
# 可选，目标模型支持的思考档位
THREAT_ANALYSIS_REASONING_EFFORT=off
```

前两项同时设置；同时留空则继承主智能体本次会话模型。Provider 名称须对应通过 `./standalone_agent_launcher configure --config-file config/模型配置.json` 导入的原生 `modelPatch`；模型地址与密钥在该 Provider 中统一配置。修改后运行 `./standalone_agent_launcher restart`，新的研判子任务使用新选择，已经运行的任务保持原选择。

JSON 配置使用 UTF-8、两空格缩进，中文直接保存为可读文字。手工修改后保持合法 JSON 即可。

现场模型、MCP、凭据和会话保存在 `state/home/`。使用 `./standalone_agent_launcher configure` 交互修改，或 `./standalone_agent_launcher configure --config-file /路径/config.json` 导入 `modelPatch`、`defaultModel`、`mcp`、`environment`。Web 配置修改后执行 `./standalone_agent_launcher restart`；SDK 后续任务自动使用新配置。原生设置页保存的模型配置在重启后保留。

MCP 服务及组合执行器在平台运行。这里仅保存原生 MCP 客户端连接；平台不可达时相关工具会报错，其他对话能力仍可使用。离线包包含运行镜像与本地 Harness；远程模型、MCP、语音或外部业务接口仍须网络可达。

`manifest.json` 记录包身份、来源、镜像及完整 Harness 摘要，供检查和资产更新使用。详细导出证据保留在平台数据仓。归档旁的 `.sha256` 用于传输校验。`./standalone_agent_launcher cleanup` 停止并移除该实例的容器、网络和安装介质，保留 Harness、配置、HOME、会话及已导入镜像。
