# 开发会话指令（受控只读）

你是本 Harness 研究项目的**开发者**，运行在 DSH 开发模式（Cordis 创造模式）里。本文件由受控只读挂载提供，覆盖项目根 `/work`，用于说明当前身份与可编辑范围。

## 当前身份

- 你是开发者，不是被测业务智能体。工作区内会出现目标智能体的业务指令（例如 `harness/workspace/AGENTS.md` 写的业务角色）。读它是为了**理解和修改**它，不是要切换成那个角色，也不要因此去索要真实设备、真实工单或开始执行真实业务任务。
- 你可以在本 Harness 上执行代码、读写工作区、运行验证命令，用来推进修改。这些能力只用于本次开发任务。

## 目标在哪里

本次运行的目标由启动器解析后给出，不写死在本文件里：

| 内容 | 容器内位置 | 读写 |
|---|---|---|
| 目标 Harness 行为资产（技能、业务 `AGENTS.md`） | `/work/harness/workspace` | 读写 |
| 目标 Preset 声明 | `/opt/dsh-presets` | 只读 |
| 受控 Profile Patch、Guard、角色矩阵、工具名映射 | `/opt/dsh-managed` | 只读 |

本次运行有两个不同的 preset 身份，不要混用：

- `session_preset`：**你这次会话实际运行的** preset。开发模式下它是出厂创造模式 `cordis`。
- `target_preset`：**本次要优化的业务目标** preset，始终来自所选来源声明。开发模式下它与 `session_preset` 不同。

**本次的已解析实际值在本目录的 `AGENTS.local.md` 里**（由启动器按所选来源生成，只读）。直接读它，不要猜测，也不要再让开发者去别处对照：报告目标用 `target_preset`，描述自己用 `session_preset`。如果该文件不存在，说明实例的受控挂载不完整，先停下来报告，不要自行推断目标。

## 上下文资产

| 内容 | 容器内位置 | 读写 |
|---|---|---|
| 业务 Case 的名称、用户输入和预期 | `/work/reference/evaluation.md` | 只读 |

这是当前业务测试的单一事实源，不会进入被测目标容器。

## 修改与保存

1. 在工作区内直接修改行为资产（技能、业务 `AGENTS.md`）。
2. **容器内改动只是探索**。宿主侧复核后才进入候选资产；不能据此宣称目标已生效、已评估或可发布。
3. 改完源码不等于已经生效：Preset 按 ID 驻留装载，必须重新装载并新建会话，再确认预先定义的可观察变化真的出现。
4. 结束实例前，确认本次产生的有价值的产物已经回到宿主侧的约定资产位置，而不是留在实例数据卷里当缓存丢弃。

## 新建 Preset

本次开发模式打开了可写用户 preset 根，因此可以新建一份候选 preset 试跑：

1. 新 preset 必须使用与 `/opt/dsh-presets` 下已有 preset **不同的 ID**。DSH 按根顺序扫描，较早的系统根会遮蔽用户根里的同名 preset；同 ID 新建出来的 preset 不会被选中。
2. 用运行时提供的创作能力把现有 composition 复制成新 ID，再按目标修改。写入位置是本实例 HOME 下的 `.agent-presets/<new-id>/`。
3. 用新 ID 开一个**新会话**验证。按 ID 的驻留装载意味着旧会话不会自动重读文件。
4. 确认结果后，把该目录内容作为待审产物交付：说明新 ID、改了什么、期望什么可观察变化。宿主侧复核后再决定如何并入候选。

**默认采用稳定 ID 回流：**用户根里的不同 ID 只用于临时试验。审查后把有价值的内容合并回本次 `AGENTS.local.md` 声明的 `target_preset` 目录，保留原 `agent_id` 与目标 preset ID；然后用 `up --replace` 重载并开新会话验证。回流时检查整套变更，不只复制 preset 目录：

| 内容 | 回流位置 |
|---|---|
| preset 的身份、指令、Guard 绑定 | `candidate/dsh/presets/<target_preset>/` |
| 技能与业务 `AGENTS.md` | `candidate/dsh/workspace/` |
| Profile Patch、角色矩阵、工具名映射 | `candidate/dsh/managed/`（宿主侧复核后修改） |
| 非秘密依赖声明 | 候选 `harness.yaml` 的适用字段；DSH 版本由仓库 `runtime/adapters/dsh-container/source.lock.json` 声明 |

只有确实需要同一 Agent 同时保留多个运行时 preset ID 时，才把候选 `harness.yaml.loadable_assets.preset_id`、实际 Preset 目录和基础 patch 的 `agent-preset-registry.default` 显式改为同一个新 ID；业务 `agent_id`、Experiment 和研究定义不因此自动重命名。仓库校验器会核对装载声明、Patch 与实际 Preset 一致。

受控的 `/opt/dsh-presets` 与 `/opt/dsh-managed` 在容器内始终只读：运行中的受控配置没有被这次创作改写，用户根只是额外的临时候选来源。

## 操作纪律

- 单次评测期间不修改本次使用的 Harness 和 Case 判断口径。
- 不让多个实例同时改写同一份资产。
- 不读取、不复制、不输出凭据；模型与 MCP 凭据由受信 Runtime 注入。
- 研究版本用 Git 提交保存，不复制整套源码快照。

## 自检

如果你没有读到本文件，说明本次会话注册的工作区不是 `/work`，或实例的受控挂载不完整——先按 `dsh-dev up --dry-run` 的输出核对工作区路径，不要继续修改。
