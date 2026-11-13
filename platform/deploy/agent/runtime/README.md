# 独立智能体运行包

本包运行所选业务版本的原生 DSH。目标机需要 Linux 和匹配架构，模型及外部 MCP 服务须从目标机可达。包内含连接凭据，按敏感文件保管。

首次解包后执行 `./install.sh -h` 查看安装参数，再运行 `./install.sh --prefix <空安装目录> --host <目标机地址> --port <端口>`。安装器校验包与标准镜像后启动 Web 智能体；SDK 包仅准备环境。

安装后进入安装目录：

```bash
./agent -h
./agent start
./agent stop
./agent restart
./agent status
./agent logs -f
./agent open
./agent cleanup
```

默认允许局域网远程访问，直接打开 `http://<目标机地址>:<端口>/assistant/`，无需登录、访问 Token 或访客 Cookie；所有访问者共享该实例的会话和数据。`open` 打开同一直接入口。独立包不连接平台统一网关，不装载平台 Guard 或访问校验服务；第三方 MCP 自身的认证仍使用配置中的凭据。启动、停止与重启保留 `state/home/` 内的原生设置、会话和数据；重启会中断当前任务，先等待任务结束。参数不正确会直接显示帮助并以非零状态退出。

DSH 原生 MCP 客户端按 Harness 配置连接平台或第三方 MCP，发现并调用工具、资源。组合由平台 MCP 服务中的 LFX 执行，组合版本、下游服务配置和执行记录留在平台数据仓。安装包不含 LFX、平台执行器或冻结流程；离线安装仅表示安装介质完整，使用模型及平台组合仍需网络连接。平台不可达时相关工具不可用，其他正常对话不受阻塞。Harness 与业务插件通过映射由 DSH Runtime 装载。

导出结束会清除本次临时构建目录和未完成归档；失败或取消同样清理。安装器先按镜像 tag、Image ID、架构和构建指纹核对 Docker 中已有的标准 Runtime；身份完全匹配时直接复用，不重复导入归档，也不重新打包镜像。安装成功会自动删除安装目录内的 `images/` 和 `offline/`，保留源安装包作为重新安装介质。源包与解包目录由其持有人按需删除。`./agent cleanup` 停止该安装并清除容器、网络及残余安装介质，保留共享标准镜像、Harness、配置、HOME 和会话；再次运行 `./agent start` 可恢复。较早版本可在平台程序根执行 `platform/dsh-deploy agent-cleanup --prefix <安装目录>`。

## 修改 Harness

宿主目录 `assets/workspace/`、`assets/presets/` 和 `assets/managed/` 分别映射到容器的 `/work/harness/workspace`、`/opt/dsh-presets` 和 `/opt/dsh-managed`，容器内只读。编辑安装目录中的资产后执行 `./agent restart` 重新装载；不会构建镜像。若包内有 `runtime/managed-projection.json` 或 SDK 的 Preset 投影，实际映射路径以 `runtime/compose.yaml` 为准。Web 包可从原工程使用 `platform/dsh-deploy agent-preview --prefix <安装目录> --update-assets` 更新同一版本的资产并重建编译投影，完整参数及边界见[独立包维护合同](https://github.com/wr5912/harness-engineering-platform/blob/main/docs/platform-design/23_%E7%A6%BB%E7%BA%BF%E4%B8%80%E9%94%AE%E6%89%93%E5%8C%85%E4%B8%8E%E5%AE%89%E8%A3%85.md#cli-与目标架构资源)；SDK 包需重新导出。普通提示词、Skill 与本地知识可直接修改映射目录。修改后的部署是本地修订，不再与原始包校验和一致。

独立访问模式由 `assets/harness.yaml` 的 `standalone.web.access: anonymous-lan` 声明；旧资产未声明时沿用匿名局域网默认值，不支持的显式模式会报错。预览提示与选择控件由业务 Harness 的 UI 插件通过原生槽位配置，Preset 默认值由业务 Patch 声明，导出保留这些资产。重启会从映射资产重新生成装载 Patch，不覆盖当前原生模型设置与 MCP 配置。端口、目标机器地址和第三方凭据属于下述安装配置。

## 修改端口与 MCP

安装器在 `state/deployment.env` 保存部署设置，修改后执行 `./agent restart`：

```bash
AGENT_PORT=18500
AGENT_HOST=192.168.1.100
```

编辑时保留原文件的 `COMPOSE_PROJECT_NAME`、`AGENT_UID` 和 `AGENT_GID`，不要把同一部署改成另一套容器。端口须在 1–65535 内且未被占用。重启重新建立端口映射，镜像与 HOME 保持不变。

MCP 的当前配置只保存在 `state/home/standalone/config.json` 的 `mcp.servers` 中，按 `id` 找到对应连接，编辑后执行 `./agent restart`。首次初始化沿用 Harness 声明的平台与外部 MCP 连接、工具选择和客户端分组。保留其余身份与连接配置；组合版本由平台执行并返回。OpenAPI 连接使用 `specUrl`（规范文件地址）、`apiKey` 和 `authHeader`；普通 MCP 连接使用 `url` 和 `headers`，Bearer Token 位于 `Authorization` Header。文件权限应保持 `600`。`config-seed/` 仅用于首次初始化，重启不会用种子覆盖当前配置。

也可通过参数更新同一份当前配置：

```bash
./agent restart --mcp-server <连接ID> --mcp-url <HTTP或HTTPS地址> --mcp-token '<Token>'
./agent configure --mcp-server <连接ID> --mcp-url <HTTP或HTTPS地址>
./agent configure --config-file <受保护的连接JSON文件>
```

`start`、`restart`、`configure` 均支持 MCP 参数。一次选择一个连接，多连接逐个配置；`--mcp-url` 对 OpenAPI 连接更新规范地址，对普通 MCP 更新服务地址。未传地址或 Token 则保留该项，`--mcp-token ''` 清除该连接凭据；保留已配置的 OpenAPI 认证 Header，普通 MCP Token 使用 Bearer。`configure` 只保存，`start` 和 `restart` 保存后启动或重载。命令行 Token 可能留在本机进程列表或终端历史，使用配置文件可避免在命令行写入值。

模型与完整连接配置可用 `./agent configure` 交互修改；JSON 导入仅接受 `modelPatch`、`defaultModel`、`mcp`、`environment`。SDK 包通过 `./agent run --input-file <JSON文件>` 显式执行任务，不会在重启时重放。
