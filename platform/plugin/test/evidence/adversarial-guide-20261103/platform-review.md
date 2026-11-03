# 平台界面与受控接入专项对抗性审查

审查日期：2026-11-03。程序基线：`41e66424b41729ca2c6fc86d65aeae95daa3159e`。本专项不修改任何 tracked 源码、测试或业务资产，不提交，不重启或写入现有平台/远端服务。证据只写入本地忽略目录 `.local/audit-guide-20261103/`。审查按当前工具阶段与当前已开放功能合同执行，不以生产化成熟度增加缺陷。

## 确认的问题

### UI-ACCESS-01：SSE 首次网络派发没有复核已取得决定的有效期

建议优先级：P1；当前受控接入合同的派发前核对缺口。

- 位置：`platform/plugin/src/instances/external/access.ts:262`、`:280`、`:284`。`authorizeExternal()` 在同文件 `:96–104` 返回同步复核函数，核对所选提供方配置、身份/风险/访问决定的最短有效期及实例绑定；`streamExternal()` 丢弃该返回值。它在写入 dispatching 记录后，只再次调用不检查该决定有效期的 `assertExternalAccess()`，随后直接 `adapterFetch()`。普通 invoke 在 `:157–163` 已正确复用复核函数，SSE 没有复用。
- 触发：受控事件订阅取得一个当前有效的短期风险或访问决定；在实际向上游发起 GET 前，访问记录同步 IO 或进程停顿消耗剩余有效期。入口、主体授权和实例绑定均保持不变。
- 影响：过期的风险/访问决定仍可创建一次新的上游订阅，返回 HTTP 200 并读取远端事件。这里证明的是**首次派发发生在决定失效之后**，不是把“决定到期必须中断已打开 SSE”当作当前承诺。
- 当前合同依据：`docs/platform-design/04_核心业务闭环与服务接口.md:223` 要求身份、目标绑定、风险与当前授权在实际派发前核对；`:251` 说明最短有效期及配置摘要核对，并明确失效不派发。其中机器资源的额外同步复核要求不应扩大解释成整个 SSE 生命周期租期要求。本问题同样有既有 `authorizeExternal()` 返回函数和普通 invoke 的直接实现依据。
- 真实路径复现：`stream-initial-expiry-probe.mts` 从当前源码 bundle 真实 `createExternalInstancesHandler()` 与 `createExternalAccessHandler()`，用真实 save/verify/enable/invoke/HTTP events 路径。只替换外部风险接口、原生 OpenCode HTTP 边界，并在 dispatching 的 `appendFileSync` 外部 IO 增加 400ms 延迟。风险事实有效期为 250ms。上游实际收到 `/api/event` 的时间比风险有效期晚 **155ms**，HTTP **200**，且收到了后续事件；`riskCalls=1`。结果在 `stream-initial-expiry-probe.json`。探针退出恢复 IO 函数并清理自己的临时数据根/服务器。
- 最小整改：保留 `authorizeExternal()` 返回的函数，使用 `adapterFetch()` 已有的 `beforeDispatch` 参数，在真实 fetch 之前复核；同步检查入口及 policy 的现有逻辑可以保留。无需新建授权层、调度器或其他安全平台。
- 最小验收：在同样的真实内部路径中，风险/访问决定在初次验证与实际 fetch 之间到期，或所选提供方配置发生变化时，上游 `/api/event` 请求计数必须为零；有效决定、入口撤销、凭据轮换、OpenCode session 过滤原有用例继续通过。

### UI-MCP-02：编排执行回执丢失被显示为执行失败，并直接引导再次执行

建议优先级：P2；用户可见状态与恢复路径不完整。

- 位置：`platform/plugin/src/mcp/client.tsx:296–330`，尤其 `:327–328`；直接执行消费者是同文件 `:408` 的“实际执行组合工具”。服务端对应 `platform/plugin/src/mcp/index.ts:287–289`，每次执行默认生成新的 `execution_id`，见 `platform/plugin/src/mcp/executor.ts:324`。
- 触发：用户实际执行一个阶段编排，上游已经受理，浏览器到平台的 RPC 响应丢失。此处没有收到明确的执行拒绝或业务失败。
- 影响：页面显示“操作失败，请检查连接并重试”，清除 busy，立即允许对同一输入再次实际执行。页面没有保存可核对的提交身份；首次 collect 返回的 run_id 若随回执丢失，用户无法从该操作中恢复对应运行。不能据此判断首次业务执行失败。
- 真实组件复现：`composition-unknown-probe.mjs` 复用现有测试的 Hook harness，编译并调用当前真实 `CompositionPage`；仅 RPC 外部边界模拟“已受理，响应丢失”。选择已发布 collect 阶段，填写事件，执行后观察到上述文案及按钮重新启用，再次点击后 RPC 接收 **2** 次相同 `{compositionId, version, revision, input.incident_id}`。结果为 `composition-unknown-probe.json`。
- 证据边界：已经证明错误的状态表达及第二次请求派发；**没有证明重复业务写入**。业务威胁分析运行器有阶段幂等与认领语义，因此本报告不声称一定重复回写或重复生成报告。
- 最小整改：对 `executeComposition` 断连使用“结果待核对，可能已执行”，保留原目标与输入，并提供已有运行记录的核对入口；为需要可恢复的阶段执行复用实际执行身份及结果查询能力。只读查询、dry 校验与明确服务端拒绝仍可按各自事实重试，不必把所有 MCP 操作引入一个新任务系统。
- 最小验收：模拟受理后响应丢失时，页面明确显示未知状态与原目标，提供核对路径；不得把未知写成执行失败或默认提示重发。核对到原运行后仍保持原运行身份；明确拒绝和普通只读查询正常重试。

## 实际检查覆盖

以 17 个任务切面检查当前入口和直接消费者。这里的切面数表示审查组织方式，不代表全库所有分支或每行代码都读完。共确认 2 个问题，完成 3 个隔离探针，其中 1 个用于说明尚无明确持续租期合同的行为，不列为缺陷。

| 切面 | 本次实际读取和核对范围 | 结果/边界 |
|---|---|---|
| 导航与对象身份 | `navigation.ts`；`client.tsx` 的页面挂载、导航、上下文、原生会话承接 | 深链校验、旧上下文隔离；未逐行审完所有 shell 样式 |
| 实时刷新与重连 | `realtime/client.ts`、`refresh.ts`；inactive 延迟、合并刷新与重连 | 未见自动重放业务写入；对应测试通过 |
| 管理助手 UI | `assistant/client.tsx` 的 create/select/status/恢复/确认组件；阅读其余摘要入口 | 任务投递保留 request_id，已受理状态核对、迟到结果避免自动跳转；后端由主审查负责 |
| 共同选择与抽屉 | `components/search-select.tsx`、`detail-drawer.tsx` | 分组选择、搜索、键盘与对象切换关闭边界；实际浏览器由主审查负责 |
| 实例动作 | `instances/client.tsx` 列表、预览/确认/实际操作、详情/readback 与访问入口关键函数 | 预览锁定、未知回执停止后续对象；非完整逐行读取所有 JSX |
| 远端登记 UI | `instances/external-client.tsx` 草稿、请求恢复、读写计数器、身份操作、会话发送/轮询、授权表单 | 按账号/工作区恢复，旧对象响应不覆盖新对象；未逐行读取全部渲染样式 |
| 远端登记后端 | `instances/external/index.ts` 与直接 registry 接口 | revision、requestId、唯一目标、验证后启用，定向测试通过 |
| 会话协议与原生完成 | `external/conversation.ts`、`adapters.ts` | 按框架消息锚点和本轮窗口判定；不把全局 idle 或历史 assistant 当完成 |
| 受控 invoke/readback | `external/access.ts` 的 authorize/invoke/send/read | 最终复核与 unknown 不重派机制存在；不需要为此新建更重抽象 |
| SSE 派发/事件过滤 | `external/access.ts:259–309` 与真实 HTTP 路径 | 确认 UI-ACCESS-01；已有当前入口撤销与 session 过滤并非缺失 |
| 机器资源访问 | `agent-access/index.ts`、`service.ts`、`contracts.ts`；store 的直接配置消费者 | JWT 后同步复核、当前 grant/绑定检查；store 未逐行审完 |
| MCP 配置/当前快照 | `mcp/control.ts`、`store.ts` 的读取、修订、原子写入、撤销快照；`mcp/client.tsx` 配置桥 | 不把筛选词写回业务配置；未完整重读所有 store 类型定义 |
| MCP 编排 UI/执行 | `mcp/client.tsx`；`mcp/index.ts` 执行/冻结版本路由；`executor.ts:317–390` | 历史版本只读、revision 冲突保留草稿、对象切换丢弃旧回执；确认 UI-MCP-02 |
| 坏 MCP 隔离 | `plugins/mcp-manager/index.ts` 的来源快照、发现/健康、响应转发关键路径；管理会话隔离测试 | 失联来源不阻塞平台管理 Session 与平台工具；未全读该插件所有协议实现 |
| 统一网关/业务控制 | `business-control/ui.tsx` 的草稿、探测、refresh/perform、限制；`core.ts` 的 context/session/resource 与 executeAuthorized；`gateway.ts` 登记、入口和页面输出 | 未确认新的缺陷；正常工具阶段 development/shared 与发布授权路径区别保留；未全读全部管理字段渲染与 gateway 协议 |
| 智能体详情/编辑 | `agents/client.tsx` 的选择失效计数、detail/read/edit/apply、版本/特性确认、启动与草稿放弃 | 有 SHA 冲突及迟到结果检查；仅功能抽样，未审完算力变体、SDK、迁移、导入全部页面 |
| 评测详情/编辑 | `evaluation/client.tsx` 的结果语义、Run 与文件身份、用例保存、评测投递/恢复、Decision、AI 抽取入口 | 对“已结束”和“通过”区分、未知启动复用请求身份；数据集标注/评测语义由数据专项负责；非完整逐行阅读 |

## 验证记录

- 第一组 10 个测试文件：`external-instances`、`external-conversation`、`external-instances-client`、`external-registration-discovery`、`agent-access`、`navigation`、`realtime`、`mcp-composition-client`、`mcp-client`、`mcp-group-v2`。**182/182 通过，0 失败，0 跳过**；日志 `platform-targeted-tests.log`。
- 第二组 5 个测试文件：`agents-client`、`evaluation-client`、`assistant-client`、`business-control-management`、`mcp-management-isolation`。**216/216 通过，0 失败，0 跳过**；日志 `platform-ui-control-tests.log`。
- 两组合计 **15 个测试文件、398 项通过**。没有执行默认 build，没有覆盖正在使用的 lib。测试读取源码，按各测试既有方式编译到临时目录或使用 Node TS 装载；部分测试调用既有 adapter lib，这不等于验证所有 Runtime 构建与正式部署。
- 新增忽略目录探针：`stream-initial-expiry-probe.mts`（确认首次派发过期）、`composition-unknown-probe.mjs`（确认未知被标失败及第二次发送）、`stream-lease-probe.mts`（仅观察到流建立后的风险过期仍传递事件）。对应 JSON 是本次实际结果。最后一个不列缺陷，因为当前合同没有明确整条 SSE 风险决定租期。

## 限制

本专项没有访问或写入现有正式远端智能体，没有据此认定 AgentScope/OpenCode/DSH 的真实业务效果。新探针的上游与风险服务均为隔离本地 HTTP 外部边界。没有操作真实浏览器；视觉、响应式及认证后页面实际装载由主审查负责。没有把定向测试全绿写成全项目已经无缺陷，也没有把目录清单写成完整逐行审查。平台/实例源码、数据事实和当前运行装载仍是不同证据层。
