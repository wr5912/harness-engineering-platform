# 跨框架接入与安全访问工程验收

本轮按 V0.6 与用户后续确认实施：真实 DSH、AgentScope、OpenCode 源码运行，用本机独立容器模拟远程已有实例，资源及模型采用模拟服务。原始输入、摘要与当前文档分工见[设计维护入口](../../../../../docs/platform-design/README.md#跨框架接入设计输入)，原件已与 Downloads 输入逐字节摘要核对一致；[使用说明](../../../../../docs/platform-design/27_跨框架接入使用说明.md)说明操作与复现，路线在设计 05、工作切片在 09。本文记录实际验证，[PA-14](../../../../../docs/ai-agent-harness项目验收矩阵.md#pa-14-跨框架接入与安全访问)为项目状态入口，测试计数与日志摘要见[工程回执](engineering-verification.json)。

## 工程与页面

登记、受控入口、机器凭据、指定资源、独立 connector 和相应 UI 已实现。原生 Web/WS 代理未开放，使用原生 Session API；AgentScope、OpenCode 支持已适配 Session SSE。任务取消、进程接管和用户委托未纳入。

[单表单组件浏览器报告](ui-preview/single-form/report.json)42/42通过、0脚本异常，保留17张对应截图。实际组件与真实管理后端、模拟上游共同验证登记、探测、启用、秘密一次交付、授权、会话、停入口及错误恢复；另覆盖单一表单、首屏3/4/5项必填、星号与必填语义、选填和默认标签、遗漏聚焦、更多设置、草稿保留及1440/768/390布局。

[响应丢失专项](ui-preview/single-form/request-recovery.json)13/13通过、0脚本异常及两张恢复图：真实handler已持久执行verify或enable后，仅在浏览器网络边界丢弃响应；待核对期间不能修改或绕过，关闭再编辑保留核对状态，回读准确对应实际阶段请求ID及当前入口状态，不重发、不自动续启。受影响UI与实时合同71/71、类型检查及隔离完整构建通过。

[正式单表单报告](formal-registration.json)18/18通过、0脚本异常，核对原生客户端模块revision变化、服务端和进程保持，以及上述首屏字段、标记、草稿和三种宽度。正式数据根未提交登记或发送模型请求，不以正式只读检查替代组件端完整写路径。原[19项组件报告](ui-preview/report.json)与[4项正式列表报告](formal-browser.json)保留为简化前基线，不作为新界面的最终回执。

构建新增隔离输出目录，并通过实际构建核对平台lib、业务薄入口和原生Web制品未被覆盖。服务端与相邻路径回归343/343通过；构建与MCP依赖定位复核3/3通过；原生Web解析器独立2/2通过。单表单及阶段请求回读修订的71项与浏览器各组另行记录；各组存在复核范围重叠，不相加作为总数，也不由343项基线推导新界面结论。

## 已核实的运行事实

- DSH 固定 b830ec950faba0a46dda564be3e2d854afed94f1 / rc.5，锁定源码完整构建7个gate通过；实际执行独立只读挂载的该制品，不把容器基础镜像标签当Runtime版本。
- AgentScope Python 2.0.8 / ff8697ec4d59ee01f3766176e70cb24ee894d6c6 使用原生Service；Msg.content消息块、异步受理与Session事件依实际接口核对。上游Python示例只作为运行输入，平台自研适配及签发为TS。
- OpenCode 2.2.5 / 9bbb8ce18c80f099e0e448775f59d965ead40a21 源码运行、local channel；原生/api接口、模型循环、MCP与签名资源已真实执行，并分别撤销/恢复资源授予验证普通catalog继续工作。

三框架均通过真实工具结果核对签名资源正常调用、撤销授予后的拒绝、撤销期间原认证catalog继续可用，以及恢复授予后再次成功；原生shell读取探针未读到connector秘密或Docker socket。DSH使用共享工作区；这些结果不推导逐用户记忆或上游存储隔离。

| 运行切面 | 脱敏证据与结果 |
|---|---|
| DSH原生API、四阶段资源并存与Bash隔离 | [dsh.json](runtime/dsh.json)；四阶段均verified，实际执行Bash且四处均UNREADABLE |
| AgentScope原生异步聊天、五阶段资源并存与Bash隔离 | [最终运行回执](runtime/agentscope-runtime-2026-11-02T14-00-09-472Z.json)；passed与isolationPassed均为true。早期fetch中断与工具未执行记录原样保留，不能把模型文字当作拒绝或完成 |
| OpenCode原生API、五阶段资源并存与shell隔离 | [资源并存](runtime/opencode-coexistence.json)、[shell隔离](runtime/opencode-shell-isolation.json)均通过 |
| Compose冷恢复 | [容器回执](runtime/compose-recovery.json)证明7个任务容器以新ID恢复；[身份比对](runtime/compose-identity-compare.json)证明kid、凭据和授予状态保持。该容器回执自身未验证Runtime API |
| 冷恢复后的实际路径 | [DSH恢复](runtime/dsh-recovery.json)14项通过，核对重建前Session的原生投影、平台归属、新请求真实工具完成及身份/授予保持；[AgentScope恢复](runtime/agentscope-recovery.json)核对旧Session、原绑定、签名与原认证工具及凭据；[OpenCode恢复](runtime/opencode-recovery.json)核对旧Session、两类MCP和资源并存 |
| 撤销不复活 | [恢复后撤销回执](runtime/compose-revocation-after.json)单独核对已撤凭据、已停授予仍保持，旧token返回401。初次7容器恢复基线没有已撤凭据，不以该基线比对替代此项 |

实际运行状态位于隔离数据工作区 `.local/cross-framework-samples`，源码不混入本仓库。AgentScope首次恢复的凭据状态核对失败保留在[原回执](runtime/agentscope-recovery-initial.json)，后续结果单独记录。

## 正式平台装载

系统全局 `/opt/dsh` 仍为rc.2，本轮未改全局安装。正式18120通过项目本地PATH入口运行锁定b830ec9源码构建的rc.5，复用原HOME、Profile、会话、地址和端口。最终进程PID为2005866；[正式Session与装载回执](runtime/platform-session-recovery.json)核对406个原Session全部保留，旧非空Session实际回读124条记录，接入列表RPC成功，机器授权模块正确拒绝未登记实例。正式数据根没有写入模拟接入登记。

原生HMR重组可重新读取Profile及bundle，但CLI `--patch` overlay是启动快照。最终prepare改变扩展缓存路径后，采用已确认无运行中Session的定向重启加载新路径。回执通过原生pluginManager核对服务端主入口及数据扩展已启用的模块路径、CLI patch对应关系、实现摘要重算一致，以及这两类服务端制品写入先于进程启动；这不额外宣称已取证内存字节。

后续单表单及阶段请求回读修订只替换`client.js`，通过原生`client-hmr`热更新，未再次prepare或重启。客户端在PID启动后发布；最终客户端摘要为`6fff2d6c760f880460f2cf31ad989543be5322431cc58775e5577fdd2dccd7df`，平台模块revision由`cdeb7589b00f`变为`84e25dba35fe`，PID2005866与服务端摘要保持一致，见正式单表单回执。客户端热更新与服务端启动前装载分别留证。浏览器、RPC和旧Session读取的范围分别记录，历史正文不进入证据。

## 回归与边界

定向回归初轮277项中270通过、7失败；在程序原始b26b7f2的独立工作树、相同依赖环境执行business-gateway同44项，得到37通过、相同7项失败。最终定位为CLI并不直接依赖全部原生服务，解析回退还会改写Runtime锚点；改为从同一CLI的公开bundle/Agent依赖闭包定位后，网关44项及最终343项均实际通过，断言未删改。中间一轮还因Python3.8不支持`str.removeprefix`失败，显式使用Python3.10后通过；原日志与各轮计数保留在工程回执，不用最终结果覆盖失败事实。

真实异地主机、真实模型效果、真实业务系统、生产稳定性、完整OAuth/OIDC与发送者约束未由本轮验证。普通bearer仍可复制重放；原生共享工作区不能等同于逐用户数据隔离。
