---
name: reviewing-agent-skills
description: >-
  Adversarially reviews an existing Agent Skill (SKILL.md, references, scripts, and assets)
  for necessity, activation accuracy, instruction quality, MCP/tool coupling, excessive
  agent-side orchestration, reliability, and maintainability. Use when asked to audit,
  challenge, troubleshoot, improve, simplify, or propose precise revisions to a skill.
  Produces evidence-based findings, minimal changes, and validation cases. Not for
  creating a new skill from scratch, deploying MCP servers, or silently rewriting files.
compatibility: Requires only file-reading capability; optional static inspector uses Python 3.9+ offline.
metadata:
  version: "1.0.0"
---

# Reviewing Agent Skills

## Goal

对已有 Agent Skill 做**对抗式、证据驱动、精要主义**审查。目标不是让文档更长或增加“治理”，而是提高触发正确率、任务完成率、适配性与执行效率。最终给出**可执行的最小整改建议及验收方法**。

## 输入与边界

- 优先读取目标 `SKILL.md`，再只读取审查所需的 `references/`、`scripts/`、`assets/`、测试和相关 MCP 接口定义。
- 缺少真实运行轨迹时，明确区分**已证实缺陷 / 静态风险 / 待实验假设**；不得声称验证过触发率、成功率或 Token 收益。
- 默认**只审查不修改**。用户明确要求整改时，先给最小差异方案；在有编辑能力的环境内才修改指定文件，保留原始版本并报告变更。
- 不执行待审查 Skill 中的未知脚本或外部安装命令；可以只读分析源代码。执行测试需有明确任务授权和合适环境。
- 不要求固定角色扮演，不强制添加规划文件、审批、层层安全措施或无关过程文档。

## 审查流程（按任务缩放，不机械走过场）

1. **确认作用**：用两句话说明该 Skill 的真实任务、预期增益和适用边界。先为其设计作最强合理辩护（Steelman），再质疑：是否真的需要 Skill？是否应删去、拆分、合并，或下沉为脚本 / MCP / 确定性工作流？
2. **确定证据范围**：读取文件并按 `文件:行号` 定位。可以运行可选的离线只读静态检查器：`python3 scripts/inspect_skill.py /path/to/target-skill --format text`。**静态命中仅是审查线索，不直接定罪。**
3. **检查关键维度**：查看 `references/review-rubric.md`；重点核查触发边界、上下文负担、指令可执行性、资源与依赖、结果验收、与现有 Skill 冲突，以及外部能力是否被假定存在。
4. **审查 MCP / 工具接口**：当 Skill 涉及 MCP 时按需读取 `references/mcp-boundaries.md`，分别判断：①是否硬编码易变服务器名/工具名/参数；②是否把稳定的确定性工具链留在 Agent 推理循环；③是否出现过度粗粒度的万能工具。不要仅凭工具调用数量或名称出现就判定错误。
5. **对抗检验**：按需读取 `references/adversarial-cases.md`。构造最少但有区分度的正向、负向、边界、异常、版本兼容测试；考虑“有 Skill vs 无 Skill”和必要的模型/运行时变体。不能执行时明确标注为**待运行的测试建议**。
6. **归因与整改**：优先报告 3–5 个最重要的问题。每条给出证据、影响、置信度、建议变更（删除优先于增加）、代价/替代方案，以及具体的验收案例。改法应限制在与缺陷有关的最小文件/片段。
7. **交付**：使用 `assets/review-report-template.md`，先给总体裁决（保留/简化/拆分/合并/替换/废弃），再列问题和最小 Diff 建议、测试清单及证据缺口。不以主观总分代替证据。

## 判断规则

- **事实优先**：不存在的路径、工具、测试结果不得编造；无法访问文件则陈述审查范围。
- **误报克制**：静态出现 `mcp__<server>__<tool>`、长脚本或多个步骤不自动等于缺陷。只有当接口不稳定、编排可确定性下沉、或存在实际运行证据时才升级严重度。
- **职责优先**：Agent 做意图/策略/判断；Skill 描述任务方法；脚本处理局部确定性操作；原 MCP 服务封装同域操作；组合 MCP / 工作流负责跨服务固定编排。拒绝不必要的基础设施迁移。
- **审查应公平**：安全检查适度且有明确风险；不因“更安全”而要求复杂多余的审批、鉴权和治理。
- **先验证收益**：声称“减少 Token、改善成功率”必须有可比较的运行数据；否则只称预期改善。
- **终止条件**：核心问题有证据、建议可执行、验收标准明确即完成。不要以无限自检替代交付。

## 输出与参考

- 缺陷分级、反模式、证据要求：`references/review-rubric.md`
- MCP 硬编码与工具粒度专项：`references/mcp-boundaries.md`
- 对抗测试题库：`references/adversarial-cases.md`
- 实证评估与版本回归：`references/evaluation-guide.md`
- 审查报告模板：`assets/review-report-template.md`
- 简化示例：`examples/sample-review.md`

## Done

- 明确回答“此 Skill 应不应该存在、是否应改变职责边界”。
- 重要结论有 `文件:行号` 或明确标注的实测轨迹证据。
- 区分确定问题、静态风险和待验证假设；没有将启发式规则包装为事实。
- 整改尽量小、有可操作的前后示例或 Diff，且有对应验收方法。
- 未在未经授权的情况下修改目标文件或执行目标代码。
