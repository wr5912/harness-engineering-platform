# reviewing-agent-skills v1.0.0

一个面向现有 **Agent Skills** 的离线友好、对抗式、证据驱动的审查技能包。**审查并提出最小整改建议**，默认不会修改目标 Skill。

## 它重点检查什么？

1. Skill 是否真的需要存在，还是应该删除、拆分、合并或下沉到脚本/MCP。
2. `name`/`description` 的触发精准度、规范有效性和渐进加载。
3. 过度约束、长提示词、无限自检、错误的职责边界。
4. **MCP 服务名/工具名硬编码与版本变化带来的耦合风险**。
5. **细粒度 MCP 造成 Agent 冗长编排、额外推理与 Token 消耗**，并据此建议原 MCP 复合工具、组合 MCP 或局部脚本。
6. 缺陷证据、最小修改 Diff 和可运行/待运行的验收方案。

它不提供真实模型调用、自动发现全部已安装 MCP Server、自动运行未知脚本或自动优化模型 Prompt 的执行平台。这些测试需要目标 Agent 环境或日志配合。

## 安装

解压后保留 `reviewing-agent-skills/` 整个文件夹，放到目标 Agent Runtime 支持的 Skills 目录中。例如 Claude Code 项目层目录可使用 `.claude/skills/reviewing-agent-skills/`；其他 Runtime（包括 DSH）请依其实际发现/加载机制配置，不假设完整兼容。

如果你的安装器只接受纯 Skill 文件夹，可以直接使用 ZIP 内 `reviewing-agent-skills/`，根目录入口是 `SKILL.md`。

## 用法

请求 Agent：

> 请使用 reviewing-agent-skills 对 `/path/to/skill` 做对抗式审查，重点检查 MCP 工具名硬编码、过长的 Agent 编排链，输出证据、最小整改 Diff 和验收测试，不要直接修改原 Skill。

### 可选：本地静态提示检查（Python 3.9+，无第三方依赖）

```bash
python3 reviewing-agent-skills/scripts/inspect_skill.py /path/to/target-skill
python3 reviewing-agent-skills/scripts/inspect_skill.py /path/to/target-skill --format json
python3 -m unittest discover -s reviewing-agent-skills/tests -v
```

- 脚本只读取目标文件，不执行目标 Skill 的代码；只做**启发式静态检查**，不代表模型能力评估。
- 输出的 `REVIEW` 是人工复核线索，不代表已经证实的缺陷。
- 使用 `--fail-on-error` 时，结构性错误导致非 0 退出，方便可选地接入 CI。

## 目录

```text
reviewing-agent-skills/
├── SKILL.md                         # 被 Agent 发现和加载的核心指令
├── README.md                        # 安装、使用、限制
├── references/
│   ├── review-rubric.md             # 审查维度、严重度、证据等级
│   ├── mcp-boundaries.md            # MCP 耦合与编排专项
│   ├── adversarial-cases.md         # 反例/边界/异常测试问题库
│   ├── evaluation-guide.md          # 实证对照及回归建议
│   └── sources.md                   # 公开参考与边界说明
├── assets/
│   └── review-report-template.md    # 审查报告模板
├── scripts/
│   └── inspect_skill.py             # 只读离线静态检查
├── tests/
│   ├── test_inspect_skill.py        # 检查器自测
│   └── trigger-cases.json           # Agent 触发测试样例（不自动执行）
└── examples/
    └── sample-review.md            # 人造案例示例
```

## 设计取向

优先精简、修复真实问题、保留合理的模型自主性。检查 MCP 工具硬编码时先验证工具契约是否稳定；检查工具调用次数时先验证是否真有可确定性下沉的固定流程。不要把静态匹配当成事实，也不要为了“专业”引入不必要的平台治理。

**说明**：本包为独立编写的技能与脚本，参考公开规范与思想；未复制第三方审查项目源码。无联网、无遥测、无外部依赖。
