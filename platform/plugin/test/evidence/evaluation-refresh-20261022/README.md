# 评测中心事件流请求风暴整改

2026-10-22 在 `172.16.138.228:18120` 平台和正在运行的评测容器旁观察与修复。程序工作树已有他人未提交的 `README.md`、`docs/platform-design/02_系统架构与部署设计.md`、`docs/platform-design/README.md` 改动，本次未触碰这些既有改动。整改完成后已重启平台验证，并把本任务变更提交推送到程序仓库与数据仓库的 `main`。

## 现象

评测运行期间打开 `/hep/#/evaluation`，console 反复出现：

```
POST http://172.16.138.228:18120/hep/harness-platform/agents/runs/index net::ERR_INSUFFICIENT_RESOURCES
  at call → loadRuns → (anonymous) → publish → follow
```

堆栈中的 `publish`/`follow` 表明请求由认证事件流（SSE）通知触发，`loadRuns` 对每个智能体各发一次 `runs/index`。页面停在旧数据，手动刷新同样失败。

## 根因

1. **触发源**：`dsh-eval-api.mjs` 的 `promptSession` 每 300ms 轮询导出 Session，并每次调用 `onArchive` → `saveEvidence`，把内容未变的 `trace.jsonl`、`tools.jsonl`、`checks.json`、`response.json` 以及 judge 证据重复原子重写。对 `evolution/experiments` 采样 15 秒记录到 176 次修改（约 11.7 次/秒），且文件大小与 sha256 不变。
2. **平台事件源**：`realtime/index.ts` 递归监视 `evolution/experiments`，包含 `runs/**` 内部；`notify` 仅 100ms 合并，持续写入下约 10 帧/秒，域为 `agents`/`catalog`。
3. **前端放大**：评测页每帧无条件执行 `loadAgents`、`loadJobs`、`loadRuns`、`loadDetail`、`loadCase`、`loadRun`、`statusEvaluation`；`loadRuns` 按智能体扇出，每个 `runs/index` 在服务端启动 Python 子进程扫描全部 Run（实测约 0.26s、59KB、22MB RSS）。页面以 `hidden` 常驻挂载，切走后仍持续重读。
4. **结果**：请求产出约 100 次/秒，浏览器同源连接吞吐约 20 次/秒，pending 请求堆积到浏览器资源上限，新请求直接失败。

## 整改

| 层 | 文件 | 变化 |
|---|---|---|
| 评测执行 | [`dsh-eval-common.mjs`](../../../../../runtime/adapters/dsh-container/dsh-eval-common.mjs) | 原子写先读取现有内容，相同则跳过；首次写入和内容变化仍正常落盘 |
| 平台事件源 | [`realtime/index.ts`](../../../src/realtime/index.ts) | `evolution/experiments/*/runs` 只观察直接子项的增删，不递归 run 内部、不处理内容变化；通知最小间隔默认 1000ms；首次仍保留 100ms 合并窗口 |
| 平台读取 | [`run_record.py`](../../../../../runtime/adapters/dsh-container/run_record.py)、[`agents/index.ts`](../../../src/agents/index.ts)、[`plugin/src/index.ts`](../../../src/index.ts) | 新增只读 `runs/overview`：一次 Python 进程返回全部 Agent 的 Run 索引；`runs/index` 原合同不变；overview 列入读取动作，不触发失效通知 |
| 评测页 | [`evaluation/client.tsx`](../../../src/evaluation/client.tsx) | `loadRuns` 改为一次 `runs/overview`；通知 250ms 去抖并要求单飞（在途时只记 pending，完成后补一次）；`active=false` 暂停自动刷新，恢复时补一次；读取失败保留上次列表 |

## 修复后测量

- 真实数据根（评测容器仍在写入）：`createPlatformEvents` 运行 10 秒，失效通知 **0** 次；修复前同一目录的写入频率约 11.7 次/秒，旧 100ms 合并下约 10 帧/秒。
- `run_record.py overview`：0.28s、83KB，返回 6 个 Agent、39 个 Experiment；`index --agent security-operations-expert` 仍返回 29 个 Experiment。
- 插件 `pnpm test`：**817 项通过、0 失败**（含新增 realtime 6 项、evaluation-client 56 项、agents overview 集成）。
- 评测公共模块：18 项通过（含相同内容重复保存不改写 mtime、内容变化仍写入）。
- 适配器定向测试：`test_dsh_eval_review_trace.mjs` 11/11、`test_dsh_eval_access.mjs` 2/2、`test_run_comparison.mjs` 7/7 通过。
- 结构化数字见 [measurements.json](measurements.json)。

## 验证边界

- **浏览器端到端验收未执行**：服务端插件和客户端 bundle 需要重启平台 `prepare`/`start` 才能装载。重启会短暂中断当前平台页面，属于未授权操作；本次未执行。重启后应按下列步骤核对并补充证据：评测运行中打开评测页 60 秒，确认 SSE 帧 ≤1/秒、`runs/overview` ≤1/次/秒、console 无 `ERR_INSUFFICIENT_RESOURCES`、新 Run 在任务完成后出现、隐藏后无请求、恢复补一次。
- 评测驱动仍每 300ms 导出 Session（HTTP 与解析开销），本次只消除未变化内容的磁盘重写。
- 启动器测试 `python3 platform/test_dsh_platform.py` 在当前 shell 环境有 26 项失败、1 项错误，首因是测试运行器调用的 Python 缺少 PyYAML / 引导服务返回 400；本次未修改启动器，未将其计为通过。
- 其他页面（首页、智能体、实例、MCP）仍按各自订阅重读，依赖服务端 1 帧/秒上限；本次未逐一增加去抖。
- 运行中 Run 详情不再随证据文件写入自动刷新；任务状态仍按 2.5s 轮询，Run 完成时刷新一次，与既有“不承诺实时 trace”的设计一致。

## 2026-10-22 后续观察：首页停留在“正在读取仓库…”

打开 `/hep/` 后首页一直显示“正在读取仓库…”。排查结果：

- 平台服务自 00:53 启动，早于本轮源码修改，运行的是旧插件；CGroup 中仍持续出现 `run_record.py index --agent ...`（旧评测页按 Agent 扇出，新代码不会产生该调用）。
- 3 秒采样平台 CPU 增加 11.45 秒（约 3.8 核）；浏览器到平台有 7 条连接，其中一条发送队列积压 1373 字节。首页 `inventory` 请求与旧评测页的高频请求竞争连接和事件循环。
- 旧代码的 `createCatalog` 首次读取只依赖 SSE 首帧；连接被占满时 `inventory` 请求不会被发起，`assets` 永远为空，因此一直显示 loading，且 `status` 不是 `error`。

已修复：`platform/plugin/src/client.tsx` 在插件激活时主动调用 `catalog.refresh()`，首次读取不再依赖事件流首帧；该改动同样需要重启平台装载。本轮没有重启平台，因为 `dsh-eval` 是平台子进程，重启会终止正在进行的 `EXP-security-operations-expert-024` 评测（观察时约 54/63 个 Case）。

恢复方式：关闭该浏览器中所有 `/hep/` 标签页（尤其评测页）后重新打开首页；评测进程不依赖浏览器，关闭页面不影响评测。若仍不可用，需在评测结束后重启平台，并完成上面的浏览器端到端验收。

## 2026-10-22 评测封存：运行中修改评测实现导致来源校验失败

`EXP-security-operations-expert-024` 的 full 评测于 17:47:48（+08）结束，69/69 个 Case 完成，但 Run 按 `failed` 封存：`summary.json` 的 `source_verification.status` 为 `changed`，`evaluation_implementation` 的初始摘要与实际摘要不一致（`b75fa988…` → `f26d9068…`），`run.yaml` 的 `status` 为 `failed`。原因是本次整改在评测运行期间修改了 `run_record.py` 与 `dsh-eval-common.mjs`，两者都在 `evaluation_implementation` 的身份清单内。

机器结果为 31 passed / 12 failed / 26 inconclusive，但按现有合同 `effective_verdict` 为 `inconclusive`，不能作为有效评测结论。Run `run-6544173e-0670-4cfd-af86-f0d27cad77d2` 保留失败事实，未改写。下一次评测会在初始化时冻结新实现摘要，封存时应一致；这也说明不得在评测运行期间修改被测实现或评测脚本，后续整改应在评测结束后进行，或重新发起评测。



## 2026-10-22 平台重启与 MOCK 评测用例清理

- 02:50 重启 `harness-platform`，登录后 `/hep/` 返回 200 且包含 `__DSH_BOOT__`；`inventory` RPC 返回 root `/home/cmp/harness-engineering-platform-data`、6 个 Agent、39 个 Experiment、125 条 Run；`runs/overview` 返回 6 个 Agent、39 个 Experiment，确认新后端接口与首页主动读取已装载。
- 按用户要求删除 `agents/security-operations-expert/evaluation.md` 中“资产关联告警代码变体研究”章节（`U-ASSET-ALERTS-001/MISSING/EMPTY/FAIL` 4 个由 MOCK 测试引入的评测用例）；`agents/detail` 回读为 65 个用例且不含这些 ID。历史 Run `run-6544173e` 保留 69 个 Case 的原始证据，未改写。
- 程序仓库中 `asset-alerts` 字样属于通用组合/工作流测试 fixture，不是这 4 个评测用例，未删除。
