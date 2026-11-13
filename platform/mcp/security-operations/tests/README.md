# MCP 公共测试

公共回归与跨层联调测试；组合专属测试保留在各组合包内的 `tests/`。

- [构建与巡检回归](test.mjs)
- [策略与应急流程及恢复回归](policy-response.test.mjs)
- [巡检运维报告模型](inspection-operations.offline.test.mjs)
- [同源聊天与HTML产物合同](inspection-chat-artifact.offline.test.mjs)

`bindings/` 保存指定实例的冻结草稿联调回执，由平台管理动作维护。

巡检测试通过锁定的官方 LFX 执行真实 flow 与 TypeScript 组件回调，仅替换外部 SOC 接口。先通过平台工具准备依赖，再执行 `HARNESS_PROGRAM_ROOT=<程序根> node --test mcp/tests/test.mjs`；不是在线业务验收。
