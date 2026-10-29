# 单业务智能体独立运行包核验

本轮验证单 Agent 的独立导出、离线知识接入和安装运行，关联 `PA-08`、`PA-12`、`PA-13`。程序基线为 `dda4afa`，实现及测试保存在当前未提交工作树；未创建业务 Experiment 或修改既有业务评判口径。

## AMD64 下载与安装

实际来源为 `inspection-delivery-demo` 的 `EXP-inspection-delivery-demo-003-r1c42f11c4f9a`。Candidate 摘要为 `2d812d5269a3ef955b7caed401888fa7c11b17c5481e11d5613122fbfd3bf247`，导出的是实际保存字节。该版本是纯代码基础台账示例，推理路由为 `harness-code-only/workflow-v1`，业务接口沿用已有基础 Mock；结果不代表真实设备健康检查或第三方业务质量通过。

首轮从真实 AgentsPage 组件和后台导出进程验证取消、接受回执丢失后的同一请求恢复、刷新回读及完整浏览器下载；请求 `5a07de1d-af80-4747-9d81-4c191e826a44` 重新确认时没有创建第二份归档。共同构建后，再从 18120 原生页面以当前模型配置完整导出、下载请求 `83919ea1-a4e1-4b81-ad91-06408998a822`，没有注入替代配置。桌面和 390px 对话框无横向溢出，页面脚本异常为零，见[桌面](export-desktop.png)、[窄屏](export-mobile.png)及[共同构建装载后的 18120](platform-18120.png)。真实页面同时完成预览、任务恢复、认证下载入口及 Escape 返回原版本检查。

最终归档大小为 `1195309376` 字节，浏览器下载与安装使用的归档 SHA-256 均为：

```text
34ec22fb7dac150f356b5310596383ffd8e129d941b90987813a616fe47e38fc
```

包保存在数据根 `.local/artifacts/agent-deployments/83919ea1-a4e1-4b81-ad91-06408998a822/`；浏览器下载副本位于程序根 `.local/deploy-verification/agent-combined-export.tar.gz`。包内含连接配置，未纳入 Git 或本证据目录。

实际解包后以 root 执行安装器，复用已有 Docker，校验清单并导入标准镜像：

| 项目 | 实际身份 |
|---|---|
| 标准镜像 | `ai-agent-harness/dsh:687f282e8-amd64-cbfc10fa115b` |
| 镜像 ID | `sha256:6ea7cbe9e99a8a2f29e9918a5112d9092ae71642fe1dbf997a612b5edafb6ca4` |
| 构建指纹 | `sha256:cbfc10fa115bc246a5d99965d3c1f8b5bf345a324ccec926ccf4cae612f2de2c` |
| 安装目录 | 程序根 `.local/combined-standalone-verification/installed/` |
| 原生界面 | `http://10.0.160.32:28799/assistant/`，使用该部署的受保护入口文件访问 |

最终包的原生 DSH 新会话实际读取三页、五台资产，工作流完成且记录模型请求为零；Markdown 681 字节、CSV 344 字节，认证下载均为 200，未认证下载均为 401，CSV 为表头加五行。只重启该独立实例后回读同一报告，摘要完全一致，未重放业务任务，模型设置、初始化标记及原会话的事件前缀保留；原生重载追加 `session/end-seed`，新浏览器自动增加一条空白会话，均如实记录。机器回执位于程序根 `.local/combined-standalone-verification/verification-summary.json`。

首轮包另外验证无效 MCP 地址不覆盖配置、环境及原生模型字节；合法的 0600 配置导入后重启，MCP、环境、初始化标记和原生模型设置保留，见 `.local/standalone-verification/final-runtime-result.json`。早期自建 28796、28797、28798 均已停止并保留状态和镜像，最终仅保留 28799 隔离实例。

## 共同源码与现有实例

按用户要求，将另一生成变体目录的 `0363361` 及其未提交修改整合到当前程序根，保留 LLM Wiki 和独立包功能。46 个程序文件中有 5 个双侧修改文件，逐块合并；最终来源补丁 SHA-256 为 `78d66cf9f5873db3264e61be0ee395742264db6142c8fbb1d2f8f16a0563bccc`，另一目录原有分支与工作树未修改。冻结及备份位于 `.local/deploy-verification/other-worktree/20261029T114510Z/`。

共同构建和离线准备通过。插件全量首轮 1166 项中 1163 项通过、1 项跳过、2 项因认证／RPC 注册夹具缺少新文档服务依赖失败；夹具补齐原生文件系统与不读取附件的服务边界后，两项定向重测通过。部署 77 项、Python 启动器 40 项、研究校验 77 项及取消 4 项通过。日志保存在 `.local/deploy-verification/combined-*.log`；未将首轮失败改写为单轮全绿。

用户授权后复用原平台 HOME 装载共同构建，18120 PID 为 `1986902`。实际 API 返回的生成合同与当前源码逐项一致，包含 `registerHybridWorkflowAgent` 与双模型角色；LLM Wiki 原生技能仍可发现，独立导出页面及下载正常。这只证明程序合同与界面装载，没有代另一任务生成或采纳新的业务变体。

现有 `inspection-code-only-20261026` 经用户授权后仅重启原容器，18502、镜像、HOME、挂载、生成配置和登记保留；原 11 个会话文件摘要全部不变，接入版本为 3，严格入口检查、原生页面及旧会话读取通过。浏览器验收额外增加一条无输入空白会话，未删除记录。回执位于 `.local/verification/business-runtime-reload/result.json`。管理端原有 306 个会话保留，验收增加一个空白会话，另一个并行管理会话完成后总数为 308；原 10 条评测记录保留。

## 知识与运行合同

源代码及真实构建 Worker 的检查覆盖未提交资产快照、复制期间变更、环境冻结、权限、敏感配置分离、目标架构、锁定依赖、取消和迁移目录后的脚本及 PDF 解析器定位。MCP 专测使用真实 Cordis 和 SDK，覆盖固定版本闭包、资源及模板、健康连接独立注册与失败配置不覆盖。

离线知识分别按管理与业务 Skill 范围收集。真实锁定版 WebRuntime 和原生 `web_fetch` 在来源服务关闭后仍可读取已归档 HTML；未知 URL 不回落公网，取消和卸载有效，管理、业务及不同 Agent 的资料不串用。默认采集路径使用显式锁定的原生 HTTP 提供方；静态检测和原生读取均不执行文档脚本。

详细使用合同由[离线一键打包与安装](../../../../../docs/platform-design/23_离线一键打包与安装.md)维护。本证据不作为另一份配置来源。

## 验证边界

- ARM64 代码及资源合同已覆盖，ARM64 独立包实机验收按用户决定留待自行执行。
- 本机已安装 Docker；缺少 Docker 的 root + systemd 安装路径通过脚本边界测试，尚未在无 Docker 的新系统实装。
- 未重打包含全部数据的完整平台离线包，未验证任意外部模型、推理环境、Python 原生扩展或所有第三方服务。
- 静态知识扫描不保证动态 URL、搜索结果或隐含知识齐全；目标网络内所需的模型和 MCP 仍须可达。
- 本轮没有作新的业务 Evaluation、Research Release 或生产部署结论。
