# 集成独立审查

审查时间：2026-11-04。基准为 `fix/PLATFORM-comprehensive-optimization` 当前工作树，程序起点 `1a32a74`；本审查只读源码及既有测试证据，不修改实现，不执行真实平台启停或业务。

审查范围：`platform/deploy/update.mts`、`platform/lifecycle.mts` 的恢复入口、外部实例流在首次派发前的复核、`login-showcase.tsx`、`login.tsx`、`home.tsx`，以及与 F02 回执、F03 数据批次、F05 公开入口、F06 SDK 解码有关的直接调用链。

## 需要修复

`update.mts/readUpdateActivity` 读取原生 Session、管理助手、评测和 SDK 状态，没有读取 F02 的组合执行回执。组合页可以直接调用 `mcp/executeComposition`，执行期间不必存在运行中的原生 Session、评测或 SDK 操作；当前更新器因此可能判为空闲并重启平台，中断在途组合。

建议枚举当前数据根 `.local/mcp-composition-executions/` 已有回执 ID，再通过只读 `mcp/compositionExecution` 核对服务器当前状态，`running` 作为忙碌对象阻止应用。不能仅凭磁盘 `running` 判定在途，因为服务器重启后同一记录应呈现 `unknown`；恢复检查不能执行组合。补充已受理且未完成组合阻止更新、完成后可继续、查询上游调用为零的行为验证。该问题已通知 root，由更新器 owner 处理。

## 其余结论

- 更新器隔离构建、来源与制品摘要复核、旧制品备份、恢复原命令及 HOME 的路径未发现其他会导致功能回退或数据丢失的问题。恢复失败保留 `unknown` 与备份目录，没有把未确认恢复报告为成功。
- F01 使用适配器发送前回调再次复核授权、有效期及配置，并只在该边界标记已派发；拒绝路径记录为未派发。未发现新的重复派发或结果误判。
- 登录轮播仍为六项，事件与认证实现未变；新增关系图属于静态展示。首页只修改辅助说明与实例指标标题，原任务派发和数值来源未变。未发现功能回退或数据丢失。
- F03 的健康批次读取容错没有放松写入或导出：相关修改和全部导出仍要求完整目录。此前发现的批量回放收集器忽略 `catalog_complete=false` 已由 owner 修复；当前源码在批量列表及各批次读取阶段均拒绝该状态并保留 partial，单条读取保留目录不完整事实。
- F05 公开 URL 优先仍保留配置入口、数据根及在线 inventory 身份核对；F06 解码器在 close 前 flush 后仍走原最终回执和 stop/unknown 判定。未发现进一步实质问题。

## 证据与限制

已读取现有日志：`update-tests.log` 15/15、`ui-tests-final.log` 47/47、`f01-tests-final.log` 21/21。F03/F05/F06 和 F02 的既有验证由各 owner 完成，详情保留对应日志；本审查不将单元及隔离 HTTP 测试等同于正式运行生效。新增的组合更新阻塞缺口尚待 owner 修复及复验。真实页面视觉、当前受管平台更新、恢复后的实际装载由 root 继续验收；本审查未操作真实会话、模型、MCP 工具或运行实例。

## 最终关闭复验

2026-11-04 再次只读核对：上文组合在途执行缺口已关闭。`readUpdateActivity` 现枚举当前数据根既有组合回执，核对文件名、execution ID 和工作区身份，再查询原服务器的 `mcp/compositionExecution`；只把当前 `running` 加入 busy。查询失败或身份不符会拒绝空闲判断，磁盘旧 `running` 以服务器 `unknown` 为准，查询不调用执行端点。

管理侧 `executeComposition` 现在对未显式传入 execution 的旧页面及直接 RPC 调用同样生成持久回执，因此也能被更新器发现。输入校验继续在派发前完成；旧调用方未提供 execution 时，实际执行原有抛错仍按既有错误合同返回，带原请求身份的新调用继续使用未知回执进行只读恢复。未发现该补充引入新的重复执行、错误成功结果或旧错误合同回退。

已读取最新 `update-composition-tests.log` 18/18 与 `f02-management-tracking-final.log` 44/44。新增用例保留真实回执存储及管理 handler：运行中的组合阻止更新，完成后更新可继续且上游执行次数不增加；旧磁盘 running 不被误判在途，回执读取失败不当作空闲；缺 execution 的管理调用执行期间已有可查询 running 回执。此前定向测试发现的旧 POST 拒绝合同变化已修复并在最终 44/44 中通过。此次复验不重复审查其余稳定功能，不替代 root 的实际运行装载验收。
