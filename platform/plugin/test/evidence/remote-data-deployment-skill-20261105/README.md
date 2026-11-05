# 远端数据更新管理技能核验

日期：2026-11-05。核验过程只维护本地管理助手 Harness，未连接或更新 232、52、170。

## 资产与入口

数据工作区 `/home/cmp/harness-engineering-platform-data` 新增 `.agents/skills/remote-data-deployment/SKILL.md` 及其 `references/commands.md`。数据根 `AGENTS.md` 和 `workspace-management` 将远端数据更新优先路由到该技能，README 提供入口。使用现有原生 Skill 发现机制，不新增任务上下文类型或固定任务入口。

核验资产对应数据仓库提交 `5e7226e3d14aec3649cd7c836641cb3597b9baa8`。

工具参数对照当前程序根 `platform/dsh-deploy --help` 与 `docs/platform-design/23_离线一键打包与安装.md`；区分安装更新与本地源码更新入口。方法按现有工具边界处理整库 HEAD、指定 Candidate 实际文件、最小安装、现场配置保留与待装载回执。仅更新数据时使用目标程序同提交的已准备来源；不能消除程序变更时报告工具缺口。

## 实际核验

- 使用已安装 DSH 的 `SkillRegistry`、`FileSystemSkillProvider`，以真实数据根 `.agents/skills` 为唯一扫描目录，经平台 `managementSkill` 成功发现并读取新技能，路径和文件 SHA-256 一致，可由模型调用。
- 同一原生注册表下，普通管理入口 `assistantConfiguration` 就绪，14 项既有管理资产就绪、缺失 0；`workspace-management` 与 `user-facing-output` 可继续读取。
- `node --test platform/plugin/test/assistant-business-assets.test.mjs`：4/4 通过，覆盖原生装载与变更读取、旧入口归并、缺失资产和 Candidate 软链接隔离。
- `skill-creator/scripts/quick_validate.py` 校验新技能通过；本次涉及文档的 18 个本地链接可达；命令参考的 6 个 Bash 代码块通过 `bash -n`，其中选项存在于当前工具帮助。示例命令没有执行部署。

## 证据边界

证明本地真实原生注册表可发现与装载，以及方法、入口和 CLI 示例一致；未运行模型自动选技测试，未验证当前长驻管理会话重载，也未执行远端部署或业务验收。后续远端交付仍需明确授权、通过维护工具同步已提交来源并核对装载，不能以本次文件保存代替远端生效。
