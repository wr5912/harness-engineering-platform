# 管理助手源码只读复验

会话 `session-6ea22501-7c81-4b5c-b024-07939e827c55`，请求 `composition-development-source-readback-20261106`，最终回复序号 `388`。以下仅保留可见正文。

**源码查询合同修正已通过本次只读复验，未再出现合同与实现冲突。**

- **使用合同**：`compositionSource` 固定版本查询需同时传 `selection.version=published` 和真实 `versionId`；文件读取使用目录返回的 `path`、`expected_sha256`，不同于图查询的择一规则。
- **固定来源**：平台目录取得 `inspection-routine` 固定版 `1bf774cbd79a…`，源码回执身份与所选版本一致。[冻结包](</home/cmp/harness-engineering-platform-data/mcp/compositions/inspection-routine/versions/b23e1b6a2026d6af553be3d12bf2edb7cec277546563a47f397f1d7ab774ad61/bundle.json>)读取成功，摘要为 `11b01c152cff…`，包内声明锁定 `lfx==1.13.1`。
- **文件与构建**：[server.py](</home/cmp/work/harness-engineering-platform/platform/mcp/lfx/server.py>)完整读取成功，共 2140 字节；当前文件摘要与 `built_sha256` 均为 `901efdb8d504…`，目录返回 `matches_build=true`。此前该文件与构建清单不一致的问题，本次已不再出现。

**限制**：冻结业务包与当前平台源码是两层来源。平台回执标示当前装载来源摘要为 `cf9a88e11497…`，但这不等于已核实独立 LFX 进程实际加载的文件字节；业务扩展当前源码与运行中摘要的一致性也仍未核对。不能据源码可读、构建匹配宣称业务执行通过。

全程只读，未发起巡检、修改资产、发布、重启或执行源码。
