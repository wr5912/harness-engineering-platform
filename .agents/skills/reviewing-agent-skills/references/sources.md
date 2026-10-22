# 公开资料与来源（检索日期：2026-10-22）

该 Skill 独立实现；以下链接为设计参考，并非使用或复制第三方项目代码。

1. [Agent Skills Specification](https://agentskills.io/specification) — 名称、描述、目录与可选资源约束。
2. [Anthropic Skill Best Practices](https://platform.claude.com/docs/zh-CN/agents-and-tools/agent-skills/best-practices) — 简洁、渐进披露、自由度、测试。
3. [Anthropic: Equipping agents for the real world with Agent Skills](https://claude.com/blog/equipping-agents-for-the-real-world-with-agent-skills) — Skills 的能力包模型。
4. [Anthropic: Lessons from Building Claude Code: How We Use Skills](https://www.linkedin.com/pulse/lessons-from-building-claude-code-how-we-use-skills-thariq-shihipar-iclmc) — 工程踩坑与 Gotchas。
5. [Lavi Nigam: 5 Agent Skill Design Patterns](https://lavinigam.com/posts/adk-skill-design-patterns/) — 五种常见设计模式。
6. [colchuck-ai/agent-skill-review](https://github.com/colchuck-ai/agent-skill-review) — Steelman/Attack 等对抗式审查思路。
7. [Anthropic skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) — 创建、评估与改进闭环。
8. [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — 通过程序化编排减少工具/上下文开销。
9. [MCP: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — 工具发现、调用及变化通知的协议机制；不等同于自动语义兼容。

补充原则：用户开发中的两个经验问题——MCP 名称重构导致 Skill 失效、细粒度 MCP 导致 Agent 编排推理链过长——是本包的重点专项，不宜被一般安全合规检查覆盖。
