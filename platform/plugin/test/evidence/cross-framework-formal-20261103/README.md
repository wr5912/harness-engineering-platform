# 正式平台跨框架接入验收（2026-11-03）

本目录记录已有AgentScope、OpenCode容器登记到正式18120平台后，从管理页面调用到原生工具结果的完整技术路径。观察时间为2026-11-03 01:04–01:42 UTC（北京时间09:04–09:42）；[项目验收矩阵PA-14](../../../../../docs/ai-agent-harness项目验收矩阵.md#pa-14-跨框架接入与安全访问)维护项目状态。[2026-11-02工程验收](../cross-framework-20261102/README.md)保留此前三框架与隔离恢复证据，本目录不覆盖历史原件。

## 当前入口与来源

正式用户入口为 **http://10.0.160.32:18120/hep/**，在“实例管理 → 接入实例”访问以下登记。容器端口是平台适配目标，不作为另一套用户入口。

| 登记实例 | 原生Runtime与锁定来源 | 目标 |
|---|---|---|
| `remote-agentscope-sample` | AgentScope Python 2.0.8，`ff8697ec4d59ee01f3766176e70cb24ee894d6c6` | 原生Service，`127.0.0.1:18652`，既有Agent选择器 |
| `remote-opencode-sample` | OpenCode 2.2.5，`9bbb8ce18c80f099e0e448775f59d965ead40a21`，source/local channel | 原生`/api`，`127.0.0.1:18655`，工作目录`/workspace` |

[平台装载回执](runtime/platform-loaded.json)核对正式PID2303012、原程序根与数据根、原生插件启用及新CLI patch缓存路径。平台使用DSH `0.2.1-rc.5`锁定源码`b830ec950faba0a46dda564be3e2d854afed94f1`，系统全局`/opt/dsh`仍为rc.2。实现摘要为`90c095a45a071e99e53baa2ff7c14679a112126948a9f9537de34f676dd1564b`，sourceIndex的42个来源文件、重新计算摘要及制品关联均匹配。

观察时程序远端`main`为`da8ea79ceab272276140c345d990c3e992040dea`，数据远端`main`为`17d1030`，再次fetch无新提交。本地`fix/PLATFORM-external-risk-provider`包含尚未提交的6个源码/测试文件修复，当前运行制品已包含对应实现；本回执不声明远端`main`已经包含这些修复。

正式平台本轮只重启一次，保留原HOME、地址和406个历史Session；旧非空Session的124条记录摘要一致，正文没有归档。配置去除本次新增的3个外部接入字段后与原配置相同，20条既有网关登记保留。两项登记、验证和启用结果见[登记回执](runtime/registration.json)。

## 调用与权限结果

管理页面以受信`platform-owner`访问真实共同控制路径，经过所选风险提供方与入口策略后派发原生请求。[模拟风险拒绝](runtime/risk-denial.json)对两个实例的owner输入均记录`not_dispatched`，拒绝后读取恢复成功。外部接入使用既有18650模拟`/risk`，原DSH的53101提供方保持不变；字段及选用语义只在[接口合同](../../../../../docs/platform-design/04_核心业务闭环与服务接口.md#external-access-risk-provider)维护。

两个实例分别使用独立的正式机器身份及connector，只授予模拟资源`A-1`读取。原认证`native_catalog`继续独立使用，不依赖Harness签名。[OpenCode资源边界](runtime/opencode-resource-verified.json)实际读取`A-1`，同一读取token访问`B-1`返回`object_forbidden`且无新增派发；申请`assets:write`返回`invalid_scope`且不签发token。秘密文件、key、token和Cookie未归档。

| 运行事实 | 原始脱敏回执 |
|---|---|
| 正式登记前的原服务、依赖与旧状态 | [AgentScope就绪](runtime/agentscope-readiness.json)、[OpenCode就绪](runtime/formal-opencode-readiness.json) |
| connector切换到各自正式身份并保留原运行资产 | [AgentScope身份接入](runtime/agentscope-connector-formal.json)、[OpenCode迁移](runtime/formal-opencode-migration.json) |
| 页面创建、两类工具请求与Session映射 | [页面调用](runtime/ui-invocations.json) |
| AgentScope原生工具与旧5个Session保留 | [原生读取证明](runtime/agentscope-native-proof.json) |
| OpenCode原生工具完成、旧11个Session可读 | [原生完成与保留](runtime/opencode-native-ui.json) |
| AgentScope最终新会话默认值、选择与实际两工具 | [最终装配验收](runtime/agentscope-defaults-final.json) |

AgentScope最终启动副本摘要为`9991bcf191f632ce562a21dc98c18e84a57d263de0b89a87be0666c8bcdb2ace`，实际装载匹配。通过`create_app`公开的`StorageBase`、`WorkspaceManager`装配，在专属新Session创建时一次初始化模型，保留原生`DEFAULT`并只增加两个精确MCP读工具许可，从原生库选择`protected_assets`和`native_catalog`。普通工作区读取不重新加入显式移除的选择；已有模型、已有选择及旧Session沿用原生行为。最终7项核对和两次真实工具结果通过：签名工具返回`A-1/group A/正常`，原认证工具返回目录及`harnessSignature:false`。

装配修改只在样本自有运行启动副本，不修改AgentScope外部源码仓库，也不是平台Python实现。三个来源回执分别保留[初始默认值](runtime/agentscope-defaults-source.json)、[MCP选择装配](runtime/agentscope-defaults-mcp-source.json)和[最终仅创建时初始化](runtime/agentscope-defaults-create-only-source.json)；前两份是中间来源，最终事实以最终装配验收及最后一份来源摘要为准。验收没有逐个Session PATCH权限来制造结果。

AgentScope因装配定向重启，保留Redis、keys和HOME；原5个Session全部保留，最终装配前已有7个全部保留，当前8个、0个运行中，原1个`awaiting_permission`状态不变。OpenCode原11个加本轮页面新建共12个、0个运行中，本体没有重启。两个connector分别定向重启。

## 页面与工程核对

完整页面目录按原字节归档：基础[浏览器报告](browser/report.json)85/85、[身份与授权元数据可见性](browser/metadata-visibility.json)9/9、[完成结果可见性](browser/completed-visibility.json)26/26，各组单独记录，脚本异常为零。目录共43张截图，覆盖1440、768、390宽度、列表、详情四页及实际工具回执。

基础85项脚本的早期idle判断不足以独立证明本轮工具完成；完成结论另由每个turn的新停止/空闲事件、原生工具完成及实际工具内容交叉核对。初次完成可见性检查失败的[原回执](browser/completed-visibility-initial.json)原样保留，后续26项报告不覆盖它。

本次外部入口20项、机器授权24项、类型检查及隔离完整构建通过；既有网关44项、既有core/management/risk/provider 129项分别通过。不把分组相加，也不声明重新执行此前全部工程回归。日志位于程序根：

- `.local/external-risk-provider/external-tests.log`、`typecheck.log`、`build.log`。
- `.local/cross-framework/formal-onboarding/legacy-control-tests.log`（网关44项）、`legacy-provider-tests.log`（129项）。

15份运行JSON和完整浏览器目录的47个文件均从本轮`.local/cross-framework/`原件复制，逐文件SHA-256一致；未复制凭据文件或原生HOME。凭据扫描另见本目录`credential-scan.json`，其范围与结果以该回执为准。

## 恢复与停止

程序根为`/home/admin/work/harness-engineering-platform`，数据根为`/home/admin/harness-engineering-platform-data`。保留这两个根、本地锁定Runtime构建、专用凭据、connector配置及原生状态；本证据目录不能替代运行备份。当前主机平台启停先选定source rc.5入口：

```sh
cd /home/admin/work/harness-engineering-platform
export PATH="$PWD/.local/cross-framework/runtime-bin:/home/admin/.config/nvm/versions/node/v24.19.0/bin:$PATH"
export HARNESS_PYTHON=/usr/bin/python3.10
dsh --version
platform/dsh-platform status
platform/dsh-platform start --host 10.0.160.32 --port 18120 --public-url http://10.0.160.32:18120/hep/
```

`dsh --version`应为`0.2.1-rc.5`。停止平台使用`platform/dsh-platform stop`。平台日志为数据根`.local/platform-service/platform.log`，模拟模型、资源与签发宿主日志为程序根`.local/cross-framework/samples-server.log`；原生容器与connector日志分别用`docker logs <容器名>`读取。日志不作为凭据存储。

本次样本使用现存容器及其挂载恢复；确认模拟宿主与正式平台已就绪后，先启动Redis，再启动相关对象：

```sh
docker start hep-cross-framework-redis
docker start hep-cross-framework-agentscope-connector hep-cross-framework-opencode-connector hep-cross-framework-agentscope hep-cross-framework-opencode
```

停止这两个样本及connector使用`docker stop hep-cross-framework-agentscope hep-cross-framework-opencode hep-cross-framework-agentscope-connector hep-cross-framework-opencode-connector`；Redis保留原数据。不要用旧隔离setup配置覆盖正式身份。生成Profile扩展路径变化时，按[当前主机Runtime说明](../../../../../docs/platform-design/27_跨框架接入使用说明.md#当前主机的平台-runtime)核对无在途任务后使其生效。

## 适用边界

本轮为本机真实容器模拟远程已有实例，模型为确定性协议模拟，业务资源为模拟数据。正式owner管理页的API路径已完成任务；独立HTTP bearer入口本轮未测。`sourceIntegrity`仍为`unknown`，不由连通或工具成功推导源码完整性、全部框架兼容、真实业务效果或生产部署通过。完整原生Web/WS、取消与远端生命周期接管仍未开放。
