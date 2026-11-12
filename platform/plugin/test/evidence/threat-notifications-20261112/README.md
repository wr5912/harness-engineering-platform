# 威胁通知与 IP 配置核验

核验时间：2026-11-12 UTC。关联项目工具链路径 `PA-08/12/13`。

本次对象为 EXP027 主线 Candidate 和当前独立安装的 `28033/assistant/`，使用锁定版 DSH 的公开插件入口。没有修改原生对话和 Runtime 源码，也没有执行研判、处置或上游 NATS 发布。

## 通知合同与配置

`INCIDENT` 分别读取事件处置 `status` 与当前 AI 自动研判 `investigation_status`；插件 API 输出 `investigationStatus`。两组状态独立显示，未知值保留原值，未提供的字段不推断为“未开始”。快捷入口按最近一次明确的 AI 状态准备研判或复核草稿；发送后先查询当前详情，通知本身不授权处置，也不自动发送消息。

NATS 地址和订阅主题只读取 Candidate 的 `dsh/managed/security-operations-expert.patch.yml` 中 `security-operations-ui.config.nats.url` 与 `nats.subjects`。删除源码中原有地址、主题兜底；配置缺失、无效、连接中断均返回明确状态，其他 API 继续可用，历史通知保留。接收主题用于去重与存储，不再固定写成一个主题。现有历史类型继续可读，不依赖 `action` 或 `previousStatus`。

当前配置为 `nats://172.16.138.223:14222`、`notify.ws.incident`；这是显式配置值。安装后的 `assets/managed/` 为导出资产，实际只读挂载使用工具生成的 `runtime/projections/managed/`，两者均由同一 Candidate 更新，不在生成文件中另行维护配置。

## IP 排查

[逐行清单](ip-scan.json)记录程序树、当前 Candidate、安装资产与运行文件的 IPv4/IPv6 命中位置和地址，不保存整行源码或凭据。扫描了 4,080 个 UTF-8 文本文件，命中 2,666 行、592 个文件；该数字包括文档、样例、生成制品及随包 Python 标准库。扫描发生在保存本证据之前。

| 类别 | 核对结果与处置 |
| --- | --- |
| 隐藏的外部服务地址 | 删除通知源码的 NATS 默认地址；删除程序与当前 Candidate MCP 调试页默认填入的 `172.16.138.232:18087` OpenAPI 地址。调试页现在由用户选择或填写地址。 |
| 固定 Docker 网桥 | 五个跨框架设置、验证脚本删除 `172.17.0.1`，共用已有隔离服务生成的 `.local/endpoints.json`；读取 `origin`、`fixture`、`model`，缺失或无效时报错。没有另外建立可编辑配置副本。 |
| 已有显式配置 | NATS、语音服务、MCP 分组、外部工具和持久化服务地址保留在 Candidate Patch 中；安装生成文件跟随该来源。没有为改成域名而改变当前可用服务。 |
| 本机与网络语义 | 环回地址、监听地址、广播与 CIDR 校验保留；`ip route get 1.1.1.1` 只查询本机路由以选取接口，不访问该服务。 |
| 样例与来源材料 | 测试数据、设备策略/控制夹具、提示词示例、历史证据、包来源地址和旧地址泄漏检查保留，不把它们当作实际连接配置。 |
| 第三方与模式误报 | SDK 中的网络范围、云元数据地址规则以及 Python 标准库保持原样；IPv6 形式的切片/命名空间和浏览器版本号等模式命中不作为服务端点。 |

没有继续发现自研运行路径绕过配置的非环回外部 IP 地址。范围不含其他业务版本、其他安装目录、镜像内部二进制、依赖缓存及整个 HOME；扫描跳过软链接、二进制、超过 10 MB 的文件、依赖锁/映射文件和专用凭据文件。没有更改外部服务或批量改写历史版本。

## 验证与生效

| 验证 | 结果与证据 |
| --- | --- |
| 通知插件构建与测试 | [构建](security-ui-build.log)、[测试](security-ui-tests.log)通过。17/17 测试，以及原有界面、概览脚本通过；隔离 TCP NATS 服务覆盖全部 36 种独立状态组合、配置地址与两个自定义主题、分片、去重、用户过滤、断连历史保留及 IPv6。 |
| 同版本资产更新工具 | [9/9 测试](asset-update-tests.log)通过，覆盖增删资产、投影、清单、备份、无变更、冲突、依赖/身份变化拒绝及失败恢复。 |
| 跨框架配置消费者 | `node --test platform/plugin/test/cross-framework-endpoints.test.mjs` 1/1 通过，覆盖自定义域名/端口、缺失及无效配置；五个调用脚本经 esbuild 编译通过，未运行会写入外部样本的设置脚本。 |
| MCP 页面相邻路径 | 平台插件类型检查和构建通过。MCP 客户端及组合客户端合计 69 项：65 通过、4 失败；恢复本次三行修改后，[原版客户端](mcp-baseline-tests.log)的 53 项仍有相同 4 项自动连接检查用例失败。它们是本轮之前的差距，未记为通过。 |
| 真实浏览器 | [浏览器记录](browser.json)核对实际部署页面、原生输入区、两组中文状态、完成提示与复核草稿、390px、深色及断连保留历史，页面运行异常为零。合成消息仅在独立浏览器上下文中拦截通知 GET/已读请求；没有写入真实通知或发布 NATS 消息。 |
| 实际实例 | 通过维护工具两次更新资产（[首次](assets-update.json)、[补充校验](assets-update-final.json)），仅定向重启 28033。最后[运行回执](runtime.json)为 healthy、通知 connected，容器内插件与生成投影相同；标准镜像、端口、模型/MCP 配置保留。三个原有会话的原始字节均为当前文件前缀，原记录未丢失。 |

资产更新命令为 `platform/dsh-deploy agent-preview --agent-id security-operations-expert --source experiment:EXP-security-operations-expert-027-m-reab20c48f610 --data-root <数据根> --arch amd64 --resources-dir <原包资源目录> --prefix <28033安装目录> --update-assets --json`，随后在所有会话空闲时执行安装入口 `agent restart`。同版本更新合同见[打包安装设计](../../../../../docs/platform-design/23_离线一键打包与安装.md)。平台源码的 MCP 页面修复尚未重载到 18120；当前 28033 的 Candidate 制品已更新生效。

浏览器上下文已关闭；原生页面初始化产生的五条无用户消息空白会话保留，没有直接删除原生存储。只读上游订阅确认协议握手可用，但本次窗口没有收到真实的新 `INCIDENT`，当前历史消息均非该类型，因此真实上游新消息到达后的业务链路仍待观察。本次没有执行 Experiment Evaluation 或 Research Release，也没有更新其他实例。

## 页面证据

- [实际通知侧栏](actual.png)
- [事件已处置、AI 仍研判中，以及已完成研判的独立显示](independent-states.png)
- [390px 页面](mobile.png)
- [深色页面](dark.png)
- [断连与历史消息](disconnected.png)
