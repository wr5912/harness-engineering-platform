# 运行、适配与交付专项对抗性审查

基线：程序 `41e66424b41729ca2c6fc86d65aeae95daa3159e`。本专项为全项目审查的一部分，仅审查与复现；未改 tracked 文件，未提交、运行训练、启停现有平台/业务实例或修改外部 Runtime 源码。运行复现全部位于程序 `.local/audit-guide-20261103/`，没有读取或使用真实凭据。

## 结论

确认三个 P2 实现问题：跨用户路径映射级联替换、公开入口与内部监听分离后的研究 CLI 绑定冲突、SDK UTF-8 字符跨管道分块后的静默乱码。三者都由真实内部函数/真实 Worker 在隔离夹具中复现，不是生产化检查项。其余所核关键路径未发现需要当前报告的确定缺陷，但不据此声明全部运行、架构及恢复行为已经验收。

## 已确认问题

### R1：跨用户恢复的路径替换会再次改写已经映射到目标的路径（P2）

- 位置：`platform/deploy/paths.mts:51–67`，重点第57行；实际调用方 `platform/deploy/install.mts:109–115`。
- 触发：来源 HOME 与目标用户 HOME 不同，用户通过显式 `--prefix` 或 `--data-root` 将目标放在来源 HOME 下另一个独立目录。安装器先按较长数据根映射完成替换，再对替换结果执行较短 HOME 映射。
- 实证：`runtime-path-rewrite-repro.mts` 调用真实 `rewriteKnownPaths()`。旧数据根 `<sandbox>/old-home/data` 映射到 `<sandbox>/old-home/restored-data` 后，本应指向后者的 `gateway.sharedSecretFile` 被再次改成 `<sandbox>/new-home/restored-data/...`；`oldReferences` 仍为0。原始 JSON 回执为 `runtime-path-rewrite-repro.json`。
- 影响：显式目标路径未被遵守，恢复后的连接或共享密钥引用指向未安装目录；旧路径扫描不能识别该错误。不是所有跨用户恢复都会失败，目标完全位于新 HOME 时通常不触发。
- 最小整改：对原始文本执行一次按最长匹配优先的替换，替换产物不再进入下一条规则；保留现有映射及 JSON 校验，不增加迁移账本。
- 验收：覆盖目标位于旧 HOME 下、目标位于新 HOME 下、互相重叠的来源根及同值映射；每个生成路径应指向明确安装目标，普通映射回归保持。

### R2：有效公开入口与内部监听分离后，正式研究 RPC 客户端无法建立绑定（P2）

- 位置：`runtime/research/platform-replay-input.mts:36–44`。直接消费者包括 `collectReplayInputs`、`runtime/research/ir-review.mts:55`、`runtime/research/platform-asset-edit.mts:48`。
- 触发：正常配置中 `gateway.managementUrl` 与 `state.publicUrl` 是公开 HTTPS/NAT/反代入口，`state.url` 是本地 HTTP 监听。启动器明确支持该结构：`platform/lifecycle.mts:74–100`；部署核验器也接受 `state.url/state.publicUrl`。
- 实证：`runtime-public-url-repro.mts` 调用真实 `createPlatformReadClient()`；公开入口与配置一致时仍在认证前抛 `PLATFORM_SERVICE_WORKSPACE_MISMATCH`。仅把夹具 `state.url` 改成公开入口后，调用越过绑定检查到达凭据文件检查。未创建凭据、未联网。回执 `runtime-public-url-repro.json`。
- 影响：正式读取、IR 核对及资产 RPC 工具在平台支持的反代部署下不可用；改传内部地址又无法满足 `managementUrl` 检查。当前本机公开/监听相同的直接访问不受此问题影响。
- 最小整改：沿用现有公开入口合同核对 `state.publicUrl ?? state.url` 与登记入口及数据根，不为工具建立另一份地址配置；保留实际 RPC inventory 的身份核验。
- 验收：公开/监听相同、公开 HTTPS 与内部 HTTP 分离、旧状态没有 publicUrl、错误数据根和错误入口分别验证；真实反代连通仍需现场条件，夹具通过不代替该层验收。

### R3：SDK Worker 按 Buffer 块解码可静默破坏中文结果（P2）

- 位置：`platform/plugin/src/sdk/worker.ts:58–65`，重点第59行的 `pending += chunk.toString()`。
- 触发：UTF-8 多字节字符在子进程 stdout 两个 data 块之间分割。管道分块不保证字符边界，中文及长响应属于正常输入输出。
- 实证：`runtime-sdk-utf8-repro.mts` 启动真实 `worker.ts`，只在 CLI 进程边界使用自有模拟程序分两块发送合法 JSON 中“你好”的字节。最终真实 operation 记录为 `final_response="���好"`、`status="completed"`、进程退出0、stderr为空。回执 `runtime-sdk-utf8-repro.json`。
- 影响：响应内容损坏却仍报告完成；同一处理也用于原生事件，可能损坏非 ASCII 工具结果、文件路径或回执文本。复现没有使用真实 SDK、模型或容器，证明范围为 Worker 的实际流解析。
- 最小整改：为 stdout 使用流式 UTF-8 解码（例如 `setEncoding('utf8')` 或 `StringDecoder`），stderr 同步核对；审查直接相邻的同类行协议消费者。不要将此错误变成通用重试或重新执行任务。
- 验收：逐字节或任意块边界发送中英文、emoji和多行 JSON；验证最终内容、事件和状态原样保持，既有大行上限、未知回执、停止与代次保护不回退。

## 实际覆盖

| 链路 | 已阅读和核对的当前实现/消费者 | 反例与正向边界 |
|---|---|---|
| 平台启动与 Profile | `platform/lifecycle.mts` 全文、`dsh-platform`/`tool-env.sh`、`dsh-platform-internal.py` 的版本、Profile、MCP迁移后检查、prepare/start关键分支；设计02与部署23的当前合同 | PID出生时间、监听归属、显式地址、原生用户Patch保留、失败回滚；未执行现有服务启停 |
| 容器来源与实例 | `source_contract.py` 的身份/路径/装载/镜像指纹、`dsh-dev` 预检/同名启动/替换/停止/删除/HOME及环境继承关键分支，实例观察实现 | 预检在停旧实例前；Docker归属和HOME保留；来源锁与双架构身份，不以端口或退出码证明业务成功 |
| SDK | `sdk-instance.mts`、`sdk-instance-state.mts`、`sdk-runner.mts`、平台SDK operation/worker、SDK Profile 与独立SDK投影 | stdio本地调用、无业务HTTP映射、代次保护、根会话终态、未知不重放；复现R3 |
| Web适配 | `runtime/adapters/dsh-web/src/` 的挂载路由、客户端URL工作线程、站点配置与原生Runtime解析入口 | 子路径、升级/静态包转换、逻辑路径与公开URL分工；未另启Web服务 |
| 研究工具 | `dsh-eval` 的冻结输入、创建Run到取消/封存及停止收尾，`platform-replay-input` 的绑定/认证/只读RPC/来源核对、资产RPC入口、继承检查关键路径 | 历史Run不改写、被测/评审职责、输入冻结、来源变化；复现R2；未执行业务Evaluation |
| 交付与恢复 | deployment任务/Worker/seed；完整包pack/repository/manifest/install/runtime/paths/verify；单业务pack与snapshot关键来源/依赖分支；standalone初始化、配置、SDK/Web装载 | 缺依赖和错误镜像拒绝、包与源码快照关系、实例状态不随资产复制、原生设置保持；复现R1 |
| 知识归档 | knowledge inspect/collect/cache/local来源、PDF/文本阅读视图、standalone provider，相关测试 | 固定字节摘要与引用、离线未命中不静默转公网、缺少必需知识拒绝出包；结构与归档不证明知识质量 |

以上是入口与关键调用链的专项深读，不是对全部 Python/TS 文件每一行和全部历史分支的通读。未深入逐行的部分包括完整 MCP 迁移兼容分支、全部 dsh-dev CLI子命令、知识解析第三方库、全部训练SSH/KEV工具实现；后两类另有对应专项或需在总报告明确覆盖。

## 本次执行验证

- Node 运行/交付定向：`runtime-tests.log`，57/57通过。覆盖 lifecycle、SDK runtime/startup/module边界、部署install/端口/SDK包/编译入口/准备、仓库恢复/核验及知识收集。测试使用自有临时夹具，没有操作既有容器或平台。
- 三份最小复现均如上保留 source 与 JSON；它们确认当前缺陷，未修改实现使结果通过。
- Python 来源合同：`runtime-source-tests.log`，27/27通过；平台 prepare/Profile：`platform-prepare-tests.log`，45/45通过。三组分别执行，不冒称全量回归或真实容器运行。

## 不列为新增缺陷的边界

当前文档明确独立包没有 backup/verify 子命令，完整恢复迁移、部分ARM64目标机及真实业务尚未全量验收。它们按现有范围分别记录未实现或未验证，不因本次全项目审查自动变成必须建设的能力。未核对本机所有现有实例、真实模型/第三方MCP任务、真实ARM64安装或跨机恢复；当前结果不能替代这些实机层。
