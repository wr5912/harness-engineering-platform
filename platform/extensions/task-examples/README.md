# 任务智能体样例工具

源码在 `src/runtime.ts`；三个 Candidate 中的 `task-example-tools.mjs` 由 `build.mjs` 生成，不直接编辑。在程序根设置 `HARNESS_PROGRAM_ROOT` 与 `HARNESS_ASSET_ROOT`，执行 `node platform/extensions/task-examples/build.mjs`。可追加 Experiment ID 只重生选定 Candidate，并从管理助手 HOME 的 `.agents/skills/user-facing-output/SKILL.md` 正文更新其表达原则后缀；未选择的制品保持原 Git 版本，不能由当前共用源码推断它们已同步更新。

基础台账巡检助手的派生 Experiment 也可显式选择构建。代码变体通过 `workflowTool` 绑定一个工作流工具名，与原子业务工具一并通过同一 Preset 的工具限制；未配置时沿用原限制。

巡检样例实际读取现有 Mock 的基础资产接口，固定范围为 asset-0001 至 asset-0005。每个运行固定快照，按两条分页，未读完时不生成完整报告；下载的 Markdown/CSV 是本轮实际生成正文，不是 Mock 固定报告模板。它只证明基础模拟台账读取，不证明真实设备健康。

多步骤样例读取固定版本 autoresearch 与 EvoFlow 的公开 README，report 必须同时提供跨来源的 `comparison` 和逐来源的 `summaries`，保存后将比较结论置于报告前部、来源要点作为依据。来源完整性和比较输入存在性由工具校验，语义准确性与比较是否有效另由独立评测检查。未复制两项目平台代码。

训练样例对应 autoresearch 的真实训练实验目标，工具实现资源预检、一次真实基线、最多三个候选训练、指标比较、失败回退和产物下载。当前环境尚未具备训练前提，因此真实训练执行和效果仍待验收。没有训练算力和执行工具时保持未验收，不用推理 API 或模拟指标替代真实训练。上游固定版本为 228791fb499afffb54b46200aca536f79142f117；EvoFlow 参考版本 d921e63c6a771089db1c514a5dcd4cbc36cf95cf，主许可为 PolyForm Noncommercial，仅参考业务机制。

报告保存在实例 HOME 的 task-example-artifacts 中，使用原生实例认证下载。它们是运行产物，不作为可编辑 Harness 副本。
