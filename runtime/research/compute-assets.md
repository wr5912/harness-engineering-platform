# 算力变体资产归拢工具

`compute-assets.mts` 在本地归拢已有 Candidate 文件，或恢复训练材料的持久归档。它复用 `compute_variant.generation.entry_path`、平台 `edit` 批次和 `decision_training`，不引入另一份工作流配置，不连接平台实例，也不执行 Candidate、训练、模型服务或业务评测。

新增实现集中在 `candidate/dsh/managed/<模块>/`，入口位于模块根，按共同修改关系组织代码和 Runtime 配置。训练数据、模型工件与证据继续由所属版本的 `evaluation/training/` 和训练回执维护，不复制进 Runtime 代码目录。模块外仍被 Profile、Preset、Guard 或动态 Skill 使用的公共依赖保留原布局。

## 归拢 Candidate

使用支持 TypeScript 转换的 Node；本次验证为 Node `v24.21.0`。在程序根执行，必须明确指定绝对数据根和版本身份。以下请求文件与预览保存在数据根以外的临时目录。

请求中 `path`、`move_to` 和 `required_paths` 均相对目标 Candidate；`expected_sha256` 是现有文件的字节摘要。示例中的摘要须替换为实际读取值。

```json
{
  "edits": [
    {
      "path": "dsh/managed/routing-adapter.ts",
      "expected_sha256": "<来源文件的64位SHA-256>",
      "move_to": "dsh/managed/compute-workflow/models/routing-adapter.ts"
    },
    {
      "path": "dsh/workspace/.agents/skills/replaced-routing/SKILL.md",
      "expected_sha256": "<明确不再使用的文件的64位SHA-256>",
      "content": null
    }
  ],
  "required_paths": [
    "dsh/workspace/.agents/skills/still-used/SKILL.md",
    "dsh/managed/common/shared-adapter.ts"
  ]
}
```

省略 `content` 表示保留现有正文并改写路径；提供字符串表示以该完整正文为草稿；`null` 表示按摘要删除单个文件。只移动 Managed 文件到计划入口所属模块，不移动入口、不覆盖已有目标。清理已替代的父版目录时逐文件列明，不依据“没有静态引用”自动删除。

```bash
node --experimental-transform-types runtime/research/compute-assets.mts preview \
  --asset-root /absolute/asset-root --experiment-id VAR-alpha-001-r123456abcdef \
  --request /tmp/organize-request.json > /tmp/organize-preview.json
```

预览不写数据根。工具核对来源摘要，自动更新同一 Candidate 中可识别的相对导入、Managed/Workspace/Preset 路径和 Markdown 链接；Profile、Preset、Guard、清单、AGENTS 和显式动态依赖作为保留根。引用仍存在时拒绝删除。预览包含完整编辑批次、直接引用和 Candidate/计划/预览摘要，须按实际用途审阅，不能把静态引用列表当作完整运行依赖证明。字符串拼接、外部配置和动态选择仍需人工核对，并通过 `required_paths` 明确保留。若消费者通过 `pinned()` 或清单摘要绑定正文，修改正文时须在同一批次明确更新消费者；工具不猜测或自动替换这些业务摘要。

确认后使用预览返回的 `preview_sha256`，应用同一份预览：

```bash
node --experimental-transform-types runtime/research/compute-assets.mts apply \
  --asset-root /absolute/asset-root --experiment-id VAR-alpha-001-r123456abcdef \
  --request /tmp/organize-preview.json --expected-preview-sha256 <预览摘要>
```

应用复用现有 `edit/preview`、`edit/apply` 的格式检查、逐文件摘要与失败回滚；dry 检查结束、同步写入前再次核对整个 Candidate 和计划摘要。成功后回读目标字节、删除状态与旧路径。相同已完成批次重复应用只回读，不重写。捕获到的写入失败按原事务恢复；来源或目标冲突时保留并行内容，重新读取并预览。保留原预览和固定 Git 来源，进程被强制终止或机器断电后的恢复须先逐文件核对，不能把它当成已验证的断电事务。

归拢后旧构建摘要失效。后续获得构建或冻结授权时沿用 `compute-variants/prepare`，不另造构建、冻结或任务调度器。本工具不自动执行这些步骤。

## 从 `.local` 恢复训练材料

入口读取现有 `compute_variant.decision_training`，仅收集回执引用及请求显式补充的文件。请求沿用准备流程的 `training_files`：

```json
{
  "training_files": [
    { "path": ".local/training-job/training_config.json", "sha256": "<文件的64位SHA-256>" },
    { "path": ".local/training-job/tokenizer_config.json", "sha256": "<文件的64位SHA-256>" }
  ]
}
```

```bash
node --experimental-transform-types runtime/research/compute-assets.mts training-preview \
  --asset-root /absolute/asset-root --experiment-id VAR-alpha-001-r123456abcdef \
  --request /tmp/training-request.json > /tmp/training-preview.json
```

预览核对实际字节、来源与目标冲突，并列出拟归档路径和摘要，不创建暂存目录、不改计划。应用仍传原请求及预览返回的摘要：

```bash
node --experimental-transform-types runtime/research/compute-assets.mts training-archive \
  --asset-root /absolute/asset-root --experiment-id VAR-alpha-001-r123456abcdef \
  --request /tmp/training-request.json --expected-preview-sha256 <训练预览摘要>
```

归档使用既有 `evaluation/training/<来源回执摘要>/` 合同，保留原始回执和工件的相对目录关系；写入前重新核对同一预览摘要，完整回读后才更新 `decision_training`。新增恢复依赖进入回执 `supporting_files`。来源变化或归档冲突不覆盖旧材料；已归档且摘要相符时可重复回读，即使原 `.local` 已移除也能复用。

不递归复制 `.local`，不带入 Session、Runtime HOME、缓存、凭据文件或含凭据常量的受检文本。引用清单须只包含实际恢复必需的材料；原始业务轨迹、运维脚本和基础权重缓存不能因为同目录而整包归档。文件核验仅证明资产与摘要一致，不证明模型恢复、业务效果或训练结论。
