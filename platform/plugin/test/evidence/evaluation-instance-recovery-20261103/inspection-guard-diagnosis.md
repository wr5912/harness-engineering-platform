# EXP027 指定会话巡检拒绝的根因与整改

本记录对应当前开发环境的实例 `exp-security-operations-expert-027-cf`、原会话 `session-8427413f-46d7-4ee1-b5db-0b5091b02645`，观察时间为 2026-11-04 UTC（本地 11 月 3 日）。按用户后续明确的匿名放行原则整改，并在重载后的新 Session 验证。

## 原始失败与原则冲突

原始 Session 中，用户请求全资产常规巡检后，`mcp__inspection__list_executable_inspections` 成功；随后 `mcp__inspection__start_inspection` 以空对象调用，在进入执行函数前，被 `security-operations-guard.mjs` 的内部工具标记检查拒绝。错误文本为“巡检受管接线未核验，禁止直接使用旧 MCP 工具”，没有产生上游受理回执或巡检 runId。

直接失败点是 Guard 与工具标记不匹配，根本适用条件错误是：该实例无需登录，Guard 却仍执行访问与工具限制。无需登录的实例在未发布和已发布状态下都应直接放行。整改按认证条件跳过 Guard 安装及限制，登录受控路径保留其既有行为，错误表述改为说明具体工具插件和加载状态，不再使用“受管接线”。

只读排查没有发现锁定 DSH 原生工具注册丢失 Symbol 的证据。当前磁盘资产在原始失败后已被其他开发修改，不能用后来的文件内容反推当时内存版本，也不能据此将问题归为 DSH。未修改 DSH 源码。

## 同根因整改与实际验证

平台网关、控制服务、实例 Runtime、MCP 分组、生命周期和直接相关业务 Guard 统一以是否需要登录判断控制是否适用；匿名开发、匿名发布及恢复登录控制均有行为回归。目标实例重载后，新 Session `session-dcbcdf5b-8bcc-45f0-9e2d-a56961b53dc5` 不再出现原 Guard 错误，但暴露目录返回值格式错误：实际开发分支的目录包装器把上游 `code: "200"` 转为数字，同时保留要求字符串的输出 Schema。

目录包装器现原样返回上游回执，保留字段和类型。诊断目录存在相同转换，也已修正；现有编译入口完成 TypeScript 检查并生成 MJS。目录测试覆盖巡检与诊断，2/2 通过；发布工作树中的巡检旧实现原已原样返回，未夹带其他会话的巡检整体重写。

新 Session `session-6be90bae-7bd7-4a80-b6d2-998eb25b6d08` 中目录读取成功。第一次启动请求将 `deviceSelector` 作为 JSON 字符串传入，上游声明要求对象且带 `oneOf`，因此被本地参数检查拒绝；这是模型参数与 Schema 不符，不是已证实的 Schema 传递兼容故障。下一次仅传有效 `taskId` 的请求到达真实上游，返回：

```json
{
  "acceptanceStatus": "BLOCKED",
  "runId": null,
  "scopeIssue": {
    "errorCode": "INSPECTION_SCOPE_UNAVAILABLE",
    "message": "服务器内部错误",
    "exceptionType": "StatusException",
    "httpStatus": 500
  }
}
```

此为精简回执，`scopeIssue` 摘自原始范围问题列表。最终未创建巡检 Run，不能称为全资产巡检已恢复或业务验收通过。外部服务源码未修改，也没有在连接恢复时自动重放写请求。

## 装载与保留边界

平台已按用户授权重启，管理 Session 均保留，原在途任务中断；目标业务实例按资产装载需要定向重启，最后一次重启前无在途会话，48 个原 Session、HOME、端口和标准镜像均保留。容器只读挂载的诊断 MJS 摘要与已编译资产一致，网关和 Session 列表均为 200。平台访问与页面验证、隔离发布来源、测试及截图统一见[核验记录](README.md)和[回执](receipts.json)。
