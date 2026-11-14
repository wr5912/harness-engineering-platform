# 独立智能体配置

主机须已安装 Docker Engine 和 Compose 插件。解压后在包目录运行 `./agent install`，或直接运行 `./agent start`；两者都会按需导入 `images/dsh-runtime.tar`。完整启停、维护及 SDK 用法见 `./agent help` 和 `./agent <命令> --help`。

`deployment.env` 保存端口、访问主机、运行用户和容器项目名。同一主机部署多个 Web 副本时，分别设置 `AGENT_PORT`；容器项目名默认按安装路径区分，也可用 `COMPOSE_PROJECT_NAME` 指定。`compose.yaml` 使用标准镜像，保持 HOME 可写；通常无需修改。

默认 Harness 为包内 `harness/`，保留 `harness.yaml`、`dsh/` 和版本声明的 SDK 资产。可在启动时指定 `--harness-root /绝对路径`，或设置 `AGENT_HARNESS_ROOT`；所选目录必须有 `harness.yaml` 和原生 `dsh/`，Web、SDK 及本地工具使用同一来源。资产更新工具只更新包内、未被现场修改的 Harness，不覆盖外部目录。

`seed/standalone.json` 是首次运行的模型与 MCP 配置种子；`seed/environment.llm-api-key` 是环境键到字符串值的 JSON，仅保存模型等连接凭据。包可能含凭据，应作为私有文件传递。初始化后，修改种子不会覆盖已保存配置。

现场模型、MCP、凭据和会话保存在 `state/home/`。使用 `./agent configure` 交互修改，或 `./agent configure --config-file /路径/config.json` 导入 `modelPatch`、`defaultModel`、`mcp`、`environment`。Web 配置修改后执行 `./agent restart`；SDK 后续任务自动使用新配置。原生设置页保存的模型配置在重启后保留。

MCP 服务及组合执行器在平台运行。这里仅保存原生 MCP 客户端连接；平台不可达时相关工具会报错，其他对话能力仍可使用。离线包包含运行镜像与本地 Harness；远程模型、MCP、语音或外部业务接口仍须网络可达。

`manifest.json` 记录包身份、来源、镜像及完整 Harness 摘要，供检查和资产更新使用。详细导出证据保留在平台数据仓。归档旁的 `.sha256` 用于传输校验。`./agent cleanup` 停止并移除该实例的容器、网络和安装介质，保留 Harness、配置、HOME、会话及已导入镜像。
