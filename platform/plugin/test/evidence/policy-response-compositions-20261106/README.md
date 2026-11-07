# 策略与应急固定流程联调

本记录补充 `PA-05/06/08/12`。两个组合 `policy-change`、`emergency-action` 已经平台管理助手正式发布，指定实例解除草稿绑定后经 `policy-response-acceptance` 分组调用已发布流程；连接仍按当前 MCP 配置解析，业务状态归 AISOC，不增加本地业务台账。当前资产入口见[迁移说明](/home/cmp/harness-engineering-platform-data/mcp/docs/policy-response-migration.md)。

## 发布核对

管理会话 `session-c6b22f3c-a791-48c4-b90d-977c73b57539` 完成两项发布、服务发现及实例旧草稿绑定清除。实际发布页面见[策略](policy-change-published.png)、[应急](emergency-action-published.png)和[画布回读](published-canvas.json)；当前发布画布分别有 15 个节点／14 条连线／6 条条件连线、13 个节点／12 条连线／5 条条件连线，与发布定义一致。未修改原始接口组、六个巡检组合或其他智能体版本。

## 平台与工具链

- 流程和画布共用原生 LFX `flow.json`，保留条件及各分支终态。实际页面见[策略画布](policy-change-canvas.png)、[应急画布](emergency-action-canvas.png)和[画布回读](canvas.json)。
- 最终 MCP 执行、分组及草稿绑定定向回归 58/58、业务接口边界回归 10/10 通过；指定 Candidate Guard 回归 1/1 通过。类型检查及构建通过。隔离接口测试不能证明真实业务效果。
- 首轮真实 Session 暴露草稿工具不可见：HTTP 分组路由在实例上下文建立前生成工具快照。快照与调用现共用实例上下文；真实 HTTP MCP 路由回归核对绑定实例可发现、可调用，以及并行其他实例无法发现或调用。分组与草稿绑定回归 19/19 通过。
- 用户允许中断后，经 `platform/dsh-deploy update --interrupt-sessions --json` 更新本机 18120，回执为 `17f63d69-0f0f-4501-8a13-e7f0f8d2fee0`，状态 `applied`、装载方式 `managed-restart`。会话及持久数据保留。
- 后续真实调用暴露短流程只返回受理回执、诱发智能体反复查询的问题。两个组合改为同步返回最终结果与完整明细，平台保留原执行身份去重和结果复用；既有长流程继续异步受理。回归覆盖在途重复调用、完成后复用、失败原因及长流程兼容。第二次经同一部署工具更新，回执 `510a9bda-ecfe-4070-b539-77d5f98bf66f` 为 `applied`，实际 PID `647710`。

## 重载后的工具发现缺陷与修复

管理助手先完成指定 Candidate 的工具发现判断修正及实际重载。随后 [run-cfc5d069-29f6-49bd-9116-5b4d388dfe7c](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-cfc5d069-29f6-49bd-9116-5b4d388dfe7c/report.md) 的三个真实会话均缺少两个组合工具，原生请求头只有 115 个工具，三例失败。此处是实际工具缺失，不能与此前 U-POL-021 在工具存在时误报不可用混为一谈。

共同根因是空草稿绑定仍校验旧来源摘要；实例重载后摘要变化，读取空绑定抛错，连带阻断已发布分组发现。共享读取入口现先将空集合视为无绑定，非空绑定仍核对实例和来源。先复现再修复，草稿绑定及分组回归 19/19、类型检查通过。经维护工具更新 18120，回执 `2705763b-22fa-4443-9fb7-a5ba91a7d688` 为 applied；管理助手定向重载回执 `1ba7d868-8e37-40bc-81a5-540957639338` 完成，44 个历史会话全部保留，current、changed_files=[]。发布版本、223 依赖、原模型及指定来源未改。见[修复核对](empty-binding-fix.json)。

修复后 [run-d0b97ad9-9b5a-4642-8228-ffda70712586](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-d0b97ad9-9b5a-4642-8228-ffda70712586/report.md) 三个真实新会话均发现两个组合，工具清单各 147 项，均实际调用已发布版本。来源 matched，结束时仍 current、changed_files=[]，发布身份与依赖地址未变。两项应急准备通过，均只调用一次组合、receipts=[]，未预览、建任务或执行；EDR 的顶层 agentId 正确，均无不适用的后续菜单。

U-POL-021 仍失败：发送 protocol=TCP 后真实预览返回 `601 acl-protocol-choices`，traceId=`869e878201ac4f0b908497b7861df920`；当前字段合同的 protocol.enumValuesJson=null，未取得型号映射允许值。未保存、提交或执行，设备当前规则未知；本次 601 不能证明先前 500 已解决。最终答复笼统建议“平台侧”修复，责任表达缺口保留，应先由 AISOC 合同／型号配置方核对。本轮机器 Trial 两项通过、一项失败，封存 failed，未请求独立证据复核；未将工具恢复视为七例业务验收通过。

## 恢复 223 后七例复验

用户指定恢复原环境后，管理助手将 `ai-soc-ingest`、`ai-soc-graph`、`ai-soc-correlate` 的地址恢复为 `172.16.138.223`，保留原端口、路径和凭据配置；`ai-soc-response` 原本就在 223。其他连接未改，两个发布版本及实例来源未改。实例草稿绑定为空，七例开始前实际装载为 current。详细环境、管理回执及调用证据见 [run-28598f57-f8e5-4b29-a9af-7e86e8c69080](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-28598f57-f8e5-4b29-a9af-7e86e8c69080/report.md)。七个真实会话均完成，来源核对 matched，机器 Trial 两项通过、五项失败，封存 failed，未请求独立证据复核。

| 用例 | 本轮结果 |
| --- | --- |
| U-EMG-007/010 | 真实准备通过；EDR 首次误把 agentId 放入 params 被拒绝后纠正。均未预览、建任务或执行 |
| U-EMG-008 | 真实指令预览仍因指定设备缺少 SSH 下发凭据失败，未执行探测 |
| U-EMG-009 | 取得当前 Basic Network Scan 的真实模板 ID；独立仅创建合同仍缺失，未创建或启动扫描。多做一次组合调用，并误将未发送的输入 requestId 称为原请求号，保留 Harness 缺口 |
| U-POL-020/022 | 当前设备及字段合同读取成功；组合真实预览返回业务 500，未进入保存、提交或执行，具体根因未知 |
| U-POL-021 | 模型误报策略组合不可用，未调用组合；原生 request/header 实际含两个组合，且三例策略工具清单摘要相同。空资源目录不能证明工具缺失 |

收尾发现并行任务更新了共享 `mcp-manager.js` 制品，实例状态为 pending_reload；七例结束均早于本次观察及当前制品 mtime。该状态与已发布流程、223 依赖地址变化分别记录，不推断旧进程已装载新文件。后续须实际重载核对后另开 Run；失败记录保留，不重复执行无变化的外部阻塞。

管理助手随后对 223 的设备目录和扫描模板分别按资源及同源工具读取一次，四次均返回业务 code=200，见[读取核对](dependency-read-verification.json)。旧 401 仅代表当时管理侧失败，具体原因仍未知；本次成功只证明这些入口当前可读，不概括为所有接口正常，也未修改凭据。

## 先前发布后七例验收：依赖环境发生变化

[run-70b4fa95-c8f7-4a27-bfba-117f42867ba4](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-70b4fa95-c8f7-4a27-bfba-117f42867ba4/report.md) 使用指定版本和原实例执行全部七例；七个原生会话均完成，机器 Trial 两项准备通过、五项失败，Run 封存为 failed，来源核对 matched，未请求独立证据复核。

U-EMG-007/010 完成真实准备；前者保留首次封装字段位置错误及随后纠正的回执。U-EMG-008 因缺少 SSH 凭据未生成真实指令。U-POL-020 在真实预览返回业务 500，根因未知。其余两项策略在设备解析终止，未保存、提交或下发。U-EMG-009 未取得本轮真实模板 ID 或扫描任务；无独立仅创建合同，未创建或启动扫描。助手仍存在猜测字段、以 IP 代替 deviceId、已知合同不足后重复发现等行为缺口，逐项保存在该 Run，不因组合阻止继续就判业务通过。

同一 Run 中，`ai-soc-ingest`、`ai-soc-graph`、`ai-soc-correlate` 的连接由 `172.16.138.223` 变为 `172.16.138.232`，原始资源出现不可用，实际依赖摘要变化；见该 Run 的 `evidence/environment-drift.json`。流程版本身份不代表连接冻结；来源 matched 也不能证明外部依赖一致。这轮不构成固定依赖环境下的七例验收。用户已选择恢复 `172.16.138.223` 后另开 Run 复验，本轮失败记录保留。

## 历史草稿验收

以下 Run 保留当时的冻结草稿与环境，不作为本轮发布版本的验收结果。

固定使用 `EXP-security-operations-expert-027-f-r5efdc136f237` 和实例 `policy-response-acceptance-027-r5efdc136f237`，不修改其他版本。用例及授权以各 Run 的冻结输入为准；策略下发与设备生效、应急准备与实际执行分别判断。

首轮 [run-5348e9a5-5900-411c-a280-41302251d72d](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-5348e9a5-5900-411c-a280-41302251d72d/report.md) 的来源核对 matched；五项失败、两项跳过，未取得组合调用，不认定迁移通过。失败记录保留。管理助手随后修正本 Candidate 中与既有 Skill 冲突的固定原始接口指令。

第二轮 [run-dce582a3-71e7-4ede-932b-019e664cecab](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-dce582a3-71e7-4ede-932b-019e664cecab/report.md) 来源核对 matched，五项失败、两项跳过。真实 Session 已发现并调用组合，但仅取得受理回执，出现猜测参数与混用平台／SOC 标识；未发生策略下发或应急执行。平台修正短流程结果返回；管理助手仅在指定 Candidate 修正按实际字段契约填写和按原业务号恢复的 Skill。

第三轮 [run-945ccaf5-6463-449b-b8c0-c1cd5612f16d](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-945ccaf5-6463-449b-b8c0-c1cd5612f16d/report.md) 完整执行七例，来源核对 matched，封存为 failed：两项准备通过，五项正向目标未达成。冻结的绑定及实际装载回执见该 Run 的 `evidence/environment.json`；各例原始 Session、调用参数及回执保存在自身证据文件中。

| 用例 | 实际结果 |
| --- | --- |
| U-EMG-007 | EDR 与被管主机、真实字符串 agentId=002 核对成功，仅完成锁屏准备；未预览、建任务或执行 |
| U-EMG-010 | 指定防火墙与封禁参数核对成功，仅完成准备；未预览、建任务或执行 |
| U-EMG-008 | 真实预览因指定源设备缺少 SSH 下发凭据失败，未生成真实指令，未执行探测 |
| U-EMG-009 | 取得当前 Basic Network Scan 的真实模板 ID；外部动作合同缺少独立“仅创建”入口，未创建或启动扫描 |
| U-POL-020/021/022 | 均在真实配置预览返回业务 code=500，未进入保存、提交或执行；真实下发及设备效果未通过验收 |

准备通过不代表设备效果。预览 500 的具体根因尚未查明，不从错误文案排除参数、权限或其他问题；未发生本次下发也不证明设备当前不存在对应规则。两项准备的最终答复仍误建议非扫描动作的 `create-task`，策略答复出现多余重试及超出回执的结论，均列为同一 Candidate 的 Harness 缺口，不能据机器通过掩盖交互问题。

第三轮原生 Session 统计中，模型耗时约 28.6–113.9 秒、工具耗时约 5.2–14.0 秒；这是该轮观察，包含失败与多余调用，不构成相对原始工具基线的提速结论。后续定向复验另存 Run，不覆盖本轮失败，不提升 Research Release 或一级路径整体状态。

定向 [run-589394c5-aa41-4a2b-b9e9-9e50e9c94a8d](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-589394c5-aa41-4a2b-b9e9-9e50e9c94a8d/report.md) 封存为 failed，来源 matched：策略 U-POL-020 仅调用一次固定链，准确保留预览 500、设备状态与根因未知；真实下发仍未完成。扫描仍被外部仅创建合同缺口阻塞。U-EMG-010 准备通过，但末尾仍误建议创建任务。U-EMG-007 在草稿绑定更新完成前被研发提前启动，工具不可见，作为环境顺序错误保留；随后 [run-09e00da4-a47f-4672-b557-495168c4c10f](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-09e00da4-a47f-4672-b557-495168c4c10f/report.md) 在绑定完成后仅重跑该例，来源 matched、准备通过，仍保留条件式错误后续建议的 Harness 缺口。准备、绑定与实际工具发现的顺序已写入管理助手的组合开发方法。

最新定向 [run-71d280cc-e054-4452-aaf9-4a0170536f3f](/home/cmp/harness-engineering-platform-data/evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/runs/run-71d280cc-e054-4452-aaf9-4a0170536f3f/report.md) 来源 matched，三例均完成，机器 Trial 两项通过、一项失败，整体封存 failed，未请求独立证据复核。管理助手仅继续修改指定 Candidate 的应急 Skill，经定向重载、实际来源绑定及就绪核对后再开会话；冻结环境见该 Run 的 `evidence/environment.json`。U-EMG-007/010 各读取一次实际动作合同并调用一次固定组合，真实准备完成，最终答复已去掉不适用的创建任务或继续执行菜单，未预览、建任务或执行。U-EMG-009 在当前动作合同已证明无法仅创建时直接停止，未调用组合或继续查询扫描模板；明确外部 AISOC 服务方需提供独立仅创建入口，未把本地输入号当作 SOC 回执，未创建或启动扫描。本轮没有取得模板号或扫描任务号，创建目标仍失败；第三轮已取得的模板证据不冒充本轮结果。

此前七例仍有三类外部阻塞：策略预览业务 500、指定探测设备的 SSH 凭据缺失、扫描独立仅创建合同缺失。相关外部源码、凭据配置及设备运行状态未在本项目中修改，此前七例的正向目标为两项准备完成、五项未完成；不认定真实策略下发、设备效果、全部迁移或 Research Release 通过。
