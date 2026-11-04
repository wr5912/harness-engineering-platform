# 算力变体资产工具验证与真实资产只读清点

2026-11-04，在 `/tmp/hep-compute-assets` 完成平台工具与临时夹具验证。涉及 PA-03、PA-04、PA-07、PA-10、PA-12 的资产、来源及构建合同；本记录不更新项目总验收结论。没有启动业务评测、GPU 训练、模型服务或真实实例，没有推送、部署或迁移真实数据。

## 工具变化与验证范围

入口为 [compute-assets.mts](../../../../../runtime/research/compute-assets.mts)，参数和恢复方法见[工具说明](../../../../../runtime/research/compute-assets.md)。生成与构建共用计划入口，要求 `dsh/managed/<模块>/<入口>.ts`；构建默认读取计划入口，显式冲突拒绝，旧入口构建不再作为当前有效结果。

归拢复用平台逐文件编辑事务，训练恢复复用既有归档函数。没有增加配置事实源、构建冻结流程或评测调度器。生成期间的父版快照是来源材料；完成后按真实依赖保留公共能力，显式删除不再使用的父版文件，不用静态不可达代替动态依赖审查。

临时夹具验证正常归拢与引用改写、整理后公共导入可编译、动态 Skill 仍可达、明确被替代的 Skill 不留在结果中；来源与目标冲突拒绝、不覆盖并行写入、重复应用幂等、批次写入异常回滚。另验证 dry 期间新增依赖或计划变化时整批拒绝。训练恢复验证 `.local` 删除后仍可核对持久归档，以及 Session、凭据路径、正文凭据和目标冲突不进入归档。夹具使用本地原生 TS CLI 和真实编辑处理函数，不调用模型或业务工具。

定向检查全部通过，共 132 项；下列测试命令在 `platform/plugin/` 执行，构建命令在程序根执行。

| 命令 | 结果 |
| --- | --- |
| `node --test test/compute-assets.test.mjs test/compute-training.test.mjs` | 26 项通过，覆盖训练请求相对预览变化时写入前拒绝。 |
| `node --test test/compute-build-freeze.test.mjs test/compute-variants.test.mjs test/compute-planning-resources.test.mjs` | 95 项通过，核对计划入口、固定来源和既有构建冻结合同。 |
| `node --test --test-name-pattern 'edit\|草稿\|移动\|删除' test/agents.test.mjs` | 11 项通过，核对共享编辑路径。命令中的竖线是正则选择符。 |
| `pnpm --dir platform/plugin run build` | 通过，包含 TypeScript 检查与制品构建。 |

这里只验证临时资产和平台工具，没有运行真实算力变体；真实数据工作区原有 `AGENTS.md` 修改保持不动，本分支不修改根级 `AGENTS.md` 或总验收矩阵。

## 真实变体快照

只读对象为数据根 `/home/cmp/harness-engineering-platform-data` 的 `VAR-security-operations-expert-003-r6fcbc8e8f093`。本文的 `C` 表示该版本 `candidate/`，`E` 表示该版本根，`L` 表示数据根下 `.local/compute-variants/EXP-security-operations-expert-024-rad80a907c628/medium-kev-20261103/`。以下是清点时的文件事实，后续操作须重新读摘要。

- `change.yaml` SHA-256：`80edc4fa2a9180033e41b8ea1aa6a62fd5f92a476ba9f1bbc4f600eefda8fcc5`。
- 固定父版 `EXP-security-operations-expert-024-rad80a907c628`，`baseline_ref` 为 `git:1f162a1ce12025ffeb9d2e36c7a3ae283b41e421`。
- 计划入口 `C/dsh/managed/compute-workflow/index.ts`；已有构建静态源码清单为 12 个文件，含 `business/`、`models/`、`routing/`。主要新增代码已在模块内，不能把整个 Managed 根描述成新增散落文件。
- 与固定父版相比，Managed 根没有新增独立文件；修改的是现有两个 Guard、角色工具矩阵、子 Guard、Profile 与主 Guard。它们仍承担公共装载或访问行为，不能为目录整齐直接移入模块或删除。

模块内还存在 `business/inspection-preparation-runtime.{ts,mjs}`、`business/inspection-snapshot.ts`、`state-constructor.manifest.json`、`training/security-routing-training.py`。其中准备 Runtime 由 Preset 独立加载，未出现在入口静态清单不能证明无用。是否进一步按实际用途调整清单与训练源码，应通过同一归拢批次改引用；本次未移动。

## 后续归拢前必须保留和核对的依赖

| 当前路径或入口 | 实际用途与处理 |
| --- | --- |
| `C/dsh/managed/security-operations-expert.patch.yml`、`web-profile.package.json`，`C/dsh/presets/security-operations-expert/agent.cordis.yml` | 当前装载声明的 Profile、清单和 Preset 根；保留并随引用核对。 |
| `security-operations-ui/index.js`、`dsh-voice-hub/lib/index.js`、`threat-analysis.mjs` | Profile 直接引用的 Managed 公共能力，保留原布局及其依赖闭包。 |
| `security-operations-guard.mjs`、`policy-selection-runtime.mjs`、`policy-confirmation-runtime.mjs`、`emergency-confirmation-runtime.mjs`、`operation-result-delivery.mjs` | Preset 仍直接加载；连同 Guard 的传递依赖保留。 |
| `compute-workflow/business/inspection-preparation-runtime.mjs`、`compute-workflow/index.mjs` | Preset 加载的模块制品；修改 TS 后通过既有受控构建更新，不能把制品当第二源码。 |
| `C/dsh/workspace/AGENTS.md`、`.agents/skills/security-inspection/SKILL.md` | `business/business-contract.ts` 使用 `pinned()` 动态读取并核对摘要；必须保留，或先明确修改该运行合同及依赖。不能粗暴删除全部父版 Skill。 |
| `C/dsh/workspace/.agents/skills/` 的其他 7 个 Skill | `emergency-action`、`fault-analysis`、`playbook-impact-assessment`、`policy-configuration`、`response-planning`、`security-investigation`、`threat-analysis`。当前角色指令或公共能力仍有关联；逐项判定哪些已由编译流程替代后，再列出全部待删文件和相同批次的调用方修改。清点本身不授权删除。 |

动态固定依赖摘要为 `AGENTS.md` 的 `ab10b7e8b163f86087fb772842fb97b1f0c3c32111ceae77692ac55f9af6a8ae`，以及巡检 Skill 的 `2b80e668bd033d05b2549ff9120dc1dc9d21c0f3198e4db9f410fbe5f28eabcc`。`.local/adapter-prep` 的 `business-continuation`、`business-contract`、`business-context-projection`、`inspection-triage` 与当前模块字节不同，只能作历史来源，不能覆盖当前 Candidate。

## 已持久保存的训练成果

当前 `decision_training` 指向 `E/evaluation/training/8f815723e2c63e4eec96c17a9e5641442a23e8268519b5037480f9f63ea17c9a/receipt.json`，SHA-256 为 `9c22fa889c0db929888845dcb36c773021c7902a390b7a8da551d252d9fc70b3`。其 19 个文件引用均存在且字节摘要匹配，包括回执、四分区数据、日志、两份报告、三个工件和八个补充依赖。原始回执 `source-receipt.json` 也存在，摘要为 `8f815723e2c63e4eec96c17a9e5641442a23e8268519b5037480f9f63ea17c9a`。

已归档内容包括完整 checkpoint 目录中的 adapter、配置、tokenizer、训练配置与指标，校准 `head.pt`，状态构造器源码及路由合同。`adapter_model.safetensors` 为 43,338,624 字节，摘要 `c7d94cb9794ed10d2e60b5866bf6974c4796fc6e52275a342dc67e0ddf2bf9e3`；校准 `head.pt` 为 2,105,023 字节，摘要 `1c288d83be995fde06ed52d435ecd4d1af9db9b8c1bf371611f85a7233f9b56c`。这些成果并非仅存在于 `.local`。持久归档 `materials/.local/...` 中的 `.local` 是保留的来源路径，不是运行暂存目录。

## 建议补齐的具体训练溯源材料

下列文件在清点时尚未列入 `supporting_files`，是恢复说明的候选补充项。路径均以 `L/` 为前缀；清点只读取文件字节核对摘要，未将其当作业务验收。执行归档前审阅用途与内容，将所需项填入 `training_files`，通过 `training-preview` 核对目标，再在本次已授权的资产整理范围内执行 `training-archive`。不手工改回执或复制整个目录。

| `L/` 下相对路径 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `annotations.assistant-reviewed.jsonl` | 31110 | `0514443b428d069d1b2c69336132fee99636d7e83e03b7133b6e83a285830a1f` |
| `annotate-routing-01/samples.labeled.jsonl` | 329306 | `9594934bc3a0d83c1d3d3deee8dfca663a25e33d421afff659d69b64237f2218` |
| `split-routing-01/split-manifest.json` | 6641 | `5b156d2231e9ae2de83c360e508a161084db83fdedd319a9882be00c47fc0a7f` |
| `extract-routing-01/extraction-report.json` | 16853 | `afad41d1383bce7170249cbdc31829de9739e89270675e3a692737f683c27ff7` |
| `audit-routing-01/dataset-audit.json` | 1100 | `87ea34bb37646f9d62a2dc9acf61eb82bc7f745e8abe19872f31c46945a8d12b` |
| `gpu-retrain-01/training-request-attempt-02.json` | 1291 | `5d602a411f17c1c470cc73b62c47f89270e1c2ae747d9254c2c4b42a94d66e96` |
| `gpu-retrain-01/receipts/plan-fp32-attempt-02/training-plan.json` | 11751 | `24a9467ad5c24a43a903ddd6dcd986dadc7c2c815ccfeb87203ada66535bb619` |
| `gpu-retrain-01/checkpoint-complete-attempt-02/README.md` | 5168 | `6e5499dcafd9a541503164c3a9f0ab5e8c181046139e8344801030342d12d132` |
| `gpu-retrain-01/training-checkpoint-manifest.json` | 1836 | `0da563ca33f5904596b7203dd620659ab5ff71219576ef8d54ced77db4ca59c8` |
| `gpu-retrain-01/training-stage-report.md` | 7275 | `31fa561714c667c0c2f5d741ee989159c863734b4a15a1f91b312490877702e3` |
| `gpu-validation-01/encoding-report-attempt-02.json` | 4823 | `ed9792ca76d5281e3d21f0134579091f826e38a3c059a12b041048b714e8136b` |
| `gpu-validation-01/validation-receipt.json` | 20742 | `b534451a31ae56e2e0373c61c5d0b79d9a312e884225772526527a8daa0613f2` |
| `gpu-validation-01/validation-report.md` | 6302 | `a70198b9e74bcc6612d89d3dd9b1c07465f19e37db3f54d3f99c7533cbec76b0` |

基础模型下载缓存、远程运维/监督脚本、`.local/verification-private-files/`、SSH 状态和原始 `session.jsonl` 均不属于以上归档集合。未读取凭据文件，不复制 HOME 或 Session。当前计划无需改动核心工件引用；补充材料后由工具产生新的归档引用，目标路径以 dry 输出为准。

以上证明文件、引用及工具合同，不证明模型恢复、推理效果、中算力业务验收或 Research Release。真实迁移、动态依赖的完整运行验证及进程硬中断恢复均未执行。
