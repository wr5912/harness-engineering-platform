# 评测 Run 身份与旧数据兼容核验

2026-11-04，关联 PA-12 及 Run 初始化工具链。当前身份、接口、清理与恢复合同统一见[服务接口说明](../../../../../docs/platform-design/04_核心业务闭环与服务接口.md#task-delivery-interfaces)，表格列顺序见[页面说明](../../../../../docs/platform-design/06_界面与前后端渐进建设.md#35-当前第一阶段页面)。

本轮沿用现有 Experiment 和 Case，不修改业务 Harness、评判口径或数据侧 Skill。新评测从预览、创建、控制、目录、清单、冻结输入到页面地址使用同一个 Run ID。结果表只显示已创建 Run；创建前失败清理本请求临时数据，已创建 Run 的失败和取消保留。

## 确定性验证

| 检查 | 结果与证据 |
|---|---|
| 运行控制与旧状态 | [38 项通过](backend-tests.log)，覆盖预留、同 ID 并发、参数冲突、创建清理、未知保留、旧任务映射及清理；追加的两项在途状态断言定向执行通过 |
| 页面、首页与导航 | [136 项通过](frontend-tests.log)，覆盖 Run 合并、全量活动项、恢复只查询、失效后重新预览、旧深链和工作区隔离 |
| 领域入口 | [69 项通过](agents-tests.log)，覆盖预览到启动的同一编号、批量部分失败、模型投影清理及相邻功能 |
| 管理助手 | [86 项通过](assistant-tests.log)，覆盖当前工具合同、批量输入、取消和已有会话恢复 |
| 直接相邻调用方 | [43 项通过](adjacent-tests.log)，覆盖确认、决策抽取、Case、身份及客户端边界 |
| 更新工具 | [20 项通过](update-tests.log)，同时识别旧 jobs 与新 runs/pending；未知和局部读取错误不能作为空闲 |
| Python 首轮 | [已观察回执摘要](python-initial-summary.json)：初始化与取消 22 项、访问 55 项、冻结快照 22 项通过；当时未保存独立原始日志 |
| Python 最终补验 | [50 项通过](python-final.log)：15 项初始化及异常归属、13 项取消与交接、22 项冻结快照；含跨版本同 ID 并发和清单提交后异常的反例 |
| TypeScript | [类型检查通过](typecheck-final.log) |

Python 补验曾因根分区 `/tmp` 空间不足而有一项夹具复制失败，[失败日志保留](python-final-tmp-space-failed.log)；随后以仓库内临时目录完整重跑 50/50 通过，临时目录已清理。不将重复执行的数量累加为覆盖数。

## 实际装载与原有数据

[更新回执](update-applied.json)记录通过 `platform/dsh-deploy update` 更新当前开发环境：更新前在途列表为空，使用工具管理的重启装载服务端，PID 从 3591404 变为 3849088，地址保持 `http://10.0.160.32:18120/hep/`，保留 HOME、Profile、端口和工作区。

部署前保存[原始摘要基线](baseline.json)，覆盖 402 个已有 Run 的关键文件和 60 条旧控制记录。[装载后的核对](legacy-activation-check.json)确认 402 个文件没有修改或缺失；程序按通用规则自动清理 3 条已确认在创建前失败且没有 Run 的旧临时记录，余下 57 条保留。没有按本机 ID 编写迁移或手工定向删除旧控制文件。

## 首轮实际验收

[API 首轮](api-live01.json)通过 20/23 项：预览、撤销、禁止迟到重放、创建后身份一致、原 ID 复用、参数冲突及结果列表合同通过。正常执行与实例停止的 3 项未通过，原因见[原始失败摘要](initial-run-failures.json)：当前锁定标准 Runtime 镜像尚未在本机构建。两次已提交 Run 原样保留，没有删除或改写为成功。

[资源只读补查](api-live01-resources.json)确认首轮两个实例当前均无对应容器或状态目录；历史 `instance_stopped:false` 未改写。

[真实浏览器首轮](browser-live01.json)54/54 项通过，无页面脚本错误。使用真实 84 条 Run，覆盖首页与评测中心列顺序、完整 ID 和版本、对象类型、明暗主题、1440/768/390px、局部滚动、详情刷新返回、旧 Job 深链映射及无 Run 提示。自动原生 `session/create` 在浏览器边界被阻止 42 次，不将其计为原生会话创建验收，也没有自动预览、启动或取消评测。

## 镜像补齐后的复验

[API 第二轮](api-live02.json)22/23 项通过。正常 Run `run-68d23096-e504-4571-b7e6-ed9460f49b8e` 的失败明确发生在浏览器驱动 `workspace-connect` 阶段：rc.5 同时渲染工作区按钮和同名不可编辑输入框，原驱动误点输入框并超时。该 Run 保留为失败，实例已停止。取消 Run `run-9f341352-fc1a-47b4-b64e-c31c9b56c2ea` 在自身实际镜像证据写入后定向取消，最终为 `cancelled`，实例停止已确认；[资源回读](api-live02-resources.json)确认两者均无对应运行容器，保留原 Run 与实例目录。

[真实页面观察](api-live02-probe.json)和[截图](api-live02-probe.png)定位到工作区控件，未替换业务响应。[驱动定向 DOM 探针](browser-workspace-probe.json)9/9 通过，执行实际生产函数，覆盖中英文、新按钮与同名输入框并存、旧输入框、目录弹窗与菜单以及已就绪编辑器；页面使用工作区边界夹具，单独不证明真实 DSH 或业务 Run。[原有驱动回归](browser-driver-tests.log)22/22 通过。生产修改只优先点击实际按钮，并保留旧输入框回退，不新增生产导出或更改 Harness。

[第二轮实际界面](browser-live02.json)56/56 项通过，无脚本异常。真实 86 行覆盖原 54 项，并验证用户指定的 `run-2dfa0a95-a136-474c-a94d-8ffbd49dcea5` 完整展示和按真实 Run ID 打开详情；[活动状态回读](api-live02-active-ui.json)及[截图](api-live02-active-ui.png)补充同一完整编号的运行中行和详情。明暗主题、1440/768/390px、类型、版本、局部滚动及旧链接保持通过，主题已恢复。44 次自动原生 `session/create` 被阻止，未自动预览、启动或取消评测。代表效果：[深色桌面](browser-live02-dark-1440-left.png)、[浅色窄屏](browser-live02-light-390-left.png)。

[单 Run 第三轮](api-live03-normal.json)14/14 项生命周期检查通过：新编号 `run-de9f0702-893b-4ce4-9245-fbccbb5fe462` 的控制、四份身份、冻结驱动、实际镜像、实例停止及页面回读一致。但 Case 仍为 `error/inconclusive`，不能据此认定浏览器用例通过。[持久证据核对](api-live03-normal-diagnosis.json)确认正确工作区、Preset 和原输入，原生 Turn 已完成；驱动仍在用会话列表中截断的输入预览匹配完整输入，因而超时。原报告及 Run 保留。

浏览器驱动改为从候选根日志核对最后一条完整用户输入，不使用预览或前缀认领，保留 Preset、工作区、根会话和新旧会话检查。API 驱动直接使用创建回执中的 Session ID，无需修改。[HTTP/ZIP 边界探针](browser-session-resolution-probe.json)10/10 和[既有回归](browser-session-resolution-tests.log)22/22 通过，覆盖短输入、截断长预览、原始空白、同预览不同全文、旧会话、子会话、缺失完整输入及身份反例。

[最终正常 Run](api-live04-normal.json)17/17 项通过：`run-23c63f26-12b6-439f-9021-4272852c3b52` 使用全新预览编号，控制状态与清单均为 `completed`，进程退出码为 0，Case `U-ASSET-PAGES-001` 的实际 `execution_status:completed`、`ui_smoke_passed:true`，实例停止已确认且无遗留运行容器。业务 `verdict:inconclusive` 保持，不将浏览器冒烟当作业务语义通过。实际容器内只读挂载的驱动摘要、冻结输入和宿主源码均为 `e2a0e7d8dbddb1777918c6a71c2bfaaf9efaad9cb67a17ef2c243b54e188ad86`，实际镜像也与构建回执一致；[页面回读](api-live04-normal-ui.png)确认新编号完整展示并打开对应详情。没有重放或改写先前失败身份。

## 最终运行与历史保留

继续验收时平台处于停止状态，已按[当前主机 Runtime 说明](../../../../../docs/platform-design/27_跨框架接入使用说明.md#当前主机的平台-runtime)选用已有 rc.5 本地入口和 Python 3.10，通过项目 `start` 恢复同一 HOME、Profile、数据根和端口；未改系统全局 rc.2 或外部 Runtime 源码。[恢复日志](platform-resume.log)保留默认解释器和默认 rc.2 被入口拒绝的检查结果及成功启动回执。最终运行与历史摘要以[最终核对](final-verification.json)为准。当前平台入口为 `http://10.0.160.32:18120/hep/`，停止入口为 `./platform/dsh-platform stop`；日志位于数据根 `.local/platform-service/platform.log`。

## 构建环境准备

用户明确授权清理未使用 DSH 构建缓存后，[首批操作](cache-cleanup.json)只逐项处理已识别的缓存 ID。父层存在缓存子引用时，[同源子链回执](cache-cleanup-dependencies.json)按叶到根清理六条记录；执行前逐项核对可回收、非共享、没有范围外子引用。没有执行镜像、容器、卷或业务数据删除。并行构建和 Docker 自身回收也会改变磁盘可用空间，不能把可用空间差额全部归因于本次清理。

第一次镜像构建收到 SIGTERM，未产出目标镜像，[中断日志保留](image-build-attempt01-interrupted.log)；再次通过独立构建会话调用同一现有 `build-image.sh`，锁定源码、锁文件、Dockerfile 和镜像指纹不变。[构建回执](image-build.json)和[最终日志](image-build-attempt02.log)确认标准镜像 `ai-agent-harness/dsh:b830ec950-amd64-2ed0d15ad02e` 构建成功，实际架构 `linux/amd64`，DSH `0.2.1-rc.5`，指纹 `sha256:2ed0d15ad02e05605d5ffb34986f149efb399d1a9331d21eceae9735b4ebfaca`。没有为 Harness 另建派生镜像，未推送镜像。

最终可维护源码摘要见 [sources.json](sources.json)。

本轮验证只证明本地程序、旧数据读取、Run 生命周期和界面路径；固定 Case 使用本机 Mock 的浏览器冒烟，不构成真实外部业务效果或研究采纳结论。验收时未执行提交、推送或其他环境部署。
