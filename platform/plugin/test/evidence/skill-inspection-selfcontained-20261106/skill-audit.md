# Skill 自包含全量审查

审查时间：2026-11-06T14:02:02.838356+00:00。范围：程序研发技能、数据管理技能、全部现存 Candidate 中的 Skill，以及包内固定上游嵌套入口。共 107 个路径、55 个不同包摘要。每个包递归读取；包摘要覆盖相对文件名和文件字节，排除 __pycache__，越界符号链接另行检查。

当前原则唯一维护在数据根 AGENTS.md 的“Skill 资产自包含（硬性原则）”；本报告是本轮证据，不另设规则。程序和数据侧 reviewing-agent-skills 已加入递归资源、私有依赖、缺失文件、开发机绝对路径、符号链接和独立导出核对。检查仅用于离线维护，不进入 DSH 原生对话。

## 已处理的问题

- mcp-composition 的开发方法进入自身 references/development.md；删除旧 composition-development.md 并修正直接入站引用。
- 独立任务统一通过公开 SKILL.md 交接，补齐输入、产出和结果未知时的查询责任；不再直读兄弟 Skill 私有研究、部署和评测实现。
- KEV 数据复核与报告的共同代码迁至程序 runtime/research/kev-data，原位置删除；公开工具合同、固定来源和许可随代码维护。训练技能继续使用自身原生训练上游包，取消对部署技能私有包的无关依赖。
- dsh-trace-audit 自己维护适配方法；kev-dataset-audit 自己维护审计方法。业务事实、凭据引用和研究 Run 保持原有来源。
- 修正双重锚点及搬迁代码的直接文档、脚本和测试消费者。

## 启发式提示的人工处置

最终没有 ERROR 或 BLOCKED。65 条 REVIEW 不等同于缺陷或通过，按实际语境核对如下：

| 提示 | 数量 | 处置与边界 |
|---|---:|---|
| RES-001 | 34 | 公开 Skill 入口、项目公开合同，以及外层 kev-deploy 同包内的三份只读上游报告；检查交接责任，不复制另一包的私有方法。嵌套入口按所属完整包解析，历史包保留固定来源。 |
| META-005 | 18 | 旧 Candidate 的短 description；长度不构成自包含违规，不为本次任务改写冻结角色或扩大激活语义。 |
| MCP-001 | 10 | 已有接口示例和工具名；名称出现本身不构成依赖缺失，固定上游示例保持只读。 |
| SCRIPT-001 | 2 | 固定上游部署说明中的命令，本轮只读，未执行部署或 shell 示例。 |
| RES-004 | 1 | kev-deploy 的 scripts/kev_serve.py 明确相对自带固定上游部署包；该文件存在，并非兄弟 Skill 私有文件。 |

递归文本扫描不能穷举动态 Python/TypeScript 导入。对实际包含代码的当前 KEV、MCP、评审技能另查导入与数据路径，并运行受影响测试。历史冻结 Candidate 只核对并保留身份，未改写历史结论。固定上游文件按来源清单保留原字节；本地适配在外层维护。Skill 激活效果及业务行为由对应真实任务、运行和观察另行证明，未将 107 个包静态扫描写成 107 个业务任务通过。

## 逐包覆盖与摘要

路径 P: 相对程序根；D: 相对数据根。相同摘要的多个路径仍逐个解析其本地引用，不只扫描代表副本。

| 包路径 | 归属 | 读取文件数 | 提示数 | 包 SHA-256 |
|---|---|---:|---:|---|
| `D:.agents/skills/agent-maintenance` | 当前工作树 | 1 | 2 | `f7bc5b0ed5ec9cb1889f8b2f0fcd57b922bf8d43411ef6046738e82cfc9e1eaa` |
| `D:.agents/skills/agent-migration` | 当前工作树 | 1 | 0 | `13ff259b308242dc80c4d8c1e0ec6aaa42ab87b0c4fc980b2d2d6f7bf3054327` |
| `D:.agents/skills/compute-variant-research` | 当前工作树 | 1 | 1 | `d44b4b5e2c6104cc34b98417b4fe4aaaf6f6ccadcad40e5b7df4691407ce7be8` |
| `D:.agents/skills/decision-sample-extraction` | 当前工作树 | 1 | 1 | `2e817249aa78e8ededd08d51efe348fcfc94925e4b7ef1a83fb08a340cb0fef1` |
| `D:.agents/skills/dsh-business-plugin-development` | 当前工作树 | 13 | 2 | `39b06af239538950f004ceb473bcd5d7aabfcff2aa39d068e0a5e15d08537f52` |
| `D:.agents/skills/dsh-business-plugin-development/references/upstream/cordis-composition-reference` | 只读上游 | 2 | 0 | `266c5f2c6150c60879c75a6965987aacae41ffd6ba4057a78fd46991fcc5561c` |
| `D:.agents/skills/dsh-business-plugin-development/references/upstream/cordis-plugin-development` | 只读上游 | 7 | 1 | `30e80b5d349eb1c01b0cacbfb4cdf871f51f0657246871bfccf474a771dcf700` |
| `D:.agents/skills/dsh-business-plugin-development/references/upstream/editing-cordis-compositions` | 只读上游 | 1 | 0 | `1297f91e8bbaf537b784e23e34832c452c56e59984a329a54cdd953471e468cd` |
| `D:.agents/skills/dsh-trace-audit` | 当前工作树 | 2 | 0 | `292dab4d2c41224e49630da56d299473a00e92b8cc46c9eb77939755ac79abab` |
| `D:.agents/skills/evaluation-review` | 当前工作树 | 3 | 1 | `9e1d5f064b4854e92635d10c87af9a53a050a81b1deba3ea3faee83dcf5ff7e4` |
| `D:.agents/skills/harness-evolution` | 当前工作树 | 3 | 0 | `4b0952aab0b128778b7abad0fd00f625ff1604cf6098c63a965fde094d7a9607` |
| `D:.agents/skills/harness-experiment-fusion` | 当前工作树 | 1 | 1 | `3ed0dc60bcd2561679960855551c12d0f4d05bcb62b4614b3b452c99d743a7d7` |
| `D:.agents/skills/kev-dataset-audit` | 当前工作树 | 2 | 0 | `aabfbca87704a5500e42e4e72a20004df6218b09717630433c9bccd17ee84524` |
| `D:.agents/skills/kev-deploy` | 当前工作树 | 7 | 3 | `0e3dd97eba0d78757d088746479af478db91a3a0739bbe0ebe48c95b15cac960` |
| `D:.agents/skills/kev-deploy/references/upstream/kev-deploy` | 只读上游 | 2 | 3 | `3cd9f866ef406aaa3d83b0f9041bc5433f19f93a6396b58af6654c43853db5bc` |
| `D:.agents/skills/kev-trace-pipeline` | 当前工作树 | 14 | 0 | `b6989262a63f52f3ab68d892cb97c3fbc279c9844849362d0faaf39859270ba9` |
| `D:.agents/skills/kev-training` | 当前工作树 | 27 | 2 | `94249fe85c9da907e11126bcbfe772477916894f5922775af4b760959c34f52f` |
| `D:.agents/skills/kev-training/references/upstream/kev-finetune` | 只读上游 | 11 | 1 | `d06093a4bd5f5aa70da6330f3a74fbebd1b8bc23b3e6db1bcb35559c0e1b1368` |
| `D:.agents/skills/legacy-asset-intake` | 当前工作树 | 1 | 0 | `2c6fa47f1509c12e1c0f41043a30f42565cf2f432769f989da51e971ecf41b4a` |
| `D:.agents/skills/llm-wiki` | 当前工作树 | 1 | 3 | `f29f8022c5f1c3a2a9869a3202b63a6e6f47bd9823673625edb0456830830755` |
| `D:.agents/skills/mcp-composition` | 当前工作树 | 2 | 1 | `aba5a266a21e24b000e53f2a1a0603be95c9e89a1e32bc095228c4dc8691503a` |
| `D:.agents/skills/remote-data-deployment` | 当前工作树 | 2 | 0 | `60b47ab42ed81315e0a2c4d7949ef9970d9e731e91276b0178ffce6c362003da` |
| `D:.agents/skills/research-eval` | 当前工作树 | 2 | 1 | `d37cf58cab237557f98c2686adfef68d9623354d1f53c99b6c76d53ad9d268fc` |
| `D:.agents/skills/review-mcp-servers` | 当前工作树 | 6 | 0 | `b82eb320d0719f1fe1d284de2901d8edc0ced435612771f4ce481792c1cc4002` |
| `D:.agents/skills/reviewing-agent-skills` | 当前工作树 | 10 | 6 | `79f4447ddebb25f6d3cecb78040b993c9340fb8e320d94e856290919bc322970` |
| `D:.agents/skills/task-builder` | 当前工作树 | 1 | 0 | `a31a8e2699684136ba4bff5380d3e3e1acb4f95cad327282a330fec754ddc427` |
| `D:.agents/skills/user-facing-output` | 当前工作树 | 2 | 0 | `211de36f35439b7975e51fc3d11d24cdf9c2b1077cc922461ba453bba6a39e0e` |
| `D:.agents/skills/workspace-management` | 当前工作树 | 1 | 3 | `8391f550273becb7898356695826a1f61d6aca15e5f9a741c1ab05228c19cf25` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/emergency-action` | 冻结历史 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/fault-analysis` | 冻结历史 | 1 | 0 | `121afeb2859640ddb26cc1b79e32c02f10e2e2760c20803cc5b9f89eb72080b6` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 冻结历史 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/policy-configuration` | 冻结历史 | 1 | 0 | `be5d02d77844261a60b6ec17157ebba51f0a839e239d3d3a32e8700d277d40d9` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/response-planning` | 冻结历史 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/security-inspection` | 冻结历史 | 1 | 0 | `1281317e3358f7226a98582c4f1815b7643f64b5c6056daabc37a0550c182291` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/security-investigation` | 冻结历史 | 1 | 0 | `72843c87d38da7376f729210440703bee37fb1a1753a36ec189c52a8e2879880` |
| `D:evolution/experiments/EXP-security-operations-expert-024-rad80a907c628/candidate/dsh/workspace/.agents/skills/threat-analysis` | 冻结历史 | 1 | 0 | `b24e35703a0e4bca5da251d566a8d4e85eb0a1367c9101e9b584913bde2c798f` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/emergency-action` | 冻结历史 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/fault-analysis` | 冻结历史 | 1 | 0 | `121afeb2859640ddb26cc1b79e32c02f10e2e2760c20803cc5b9f89eb72080b6` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 冻结历史 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/policy-configuration` | 冻结历史 | 1 | 0 | `be5d02d77844261a60b6ec17157ebba51f0a839e239d3d3a32e8700d277d40d9` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/response-planning` | 冻结历史 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/security-inspection` | 冻结历史 | 1 | 0 | `1281317e3358f7226a98582c4f1815b7643f64b5c6056daabc37a0550c182291` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/security-investigation` | 冻结历史 | 1 | 0 | `72843c87d38da7376f729210440703bee37fb1a1753a36ec189c52a8e2879880` |
| `D:evolution/experiments/EXP-security-operations-expert-025-r3f8a8b3da3f1/candidate/dsh/workspace/.agents/skills/threat-analysis` | 冻结历史 | 1 | 0 | `ebbc6736301297266daa81e06c560f8bccb22b489d8e928328829f4fe6d4f0bd` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/emergency-action` | 冻结历史 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/fault-analysis` | 冻结历史 | 1 | 0 | `121afeb2859640ddb26cc1b79e32c02f10e2e2760c20803cc5b9f89eb72080b6` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 冻结历史 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/policy-configuration` | 冻结历史 | 1 | 0 | `be5d02d77844261a60b6ec17157ebba51f0a839e239d3d3a32e8700d277d40d9` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/response-planning` | 冻结历史 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/security-inspection` | 冻结历史 | 1 | 0 | `1281317e3358f7226a98582c4f1815b7643f64b5c6056daabc37a0550c182291` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/security-investigation` | 冻结历史 | 1 | 0 | `72843c87d38da7376f729210440703bee37fb1a1753a36ec189c52a8e2879880` |
| `D:evolution/experiments/EXP-security-operations-expert-026-ra06021c8deaf/candidate/dsh/workspace/.agents/skills/threat-analysis` | 冻结历史 | 1 | 0 | `b24e35703a0e4bca5da251d566a8d4e85eb0a1367c9101e9b584913bde2c798f` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/asset-onboarding` | 当前工作树 | 1 | 0 | `cddbbec8b2c26fcfad0962ae07ca43d747880c0781939f044fd298223c7394b9` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 2 | 0 | `001cb0e73b2f4ed81c6a0a4710fce613fad90cdd6a72cffa01507c5b1dea8750` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 1 | `19528e33c1695a6471298a4537fa8dd450f324bdc226b7e339acc6bafcf8dcd9` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `33fe61571e2a4d4e7bc57098379e5b7ed21cd19974cb4d05348086bd6bf8516c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `b15436221b12a2d879421e41b448824d7108742f47e1305b1f12f1eab5c7ba04` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 1 | `9f7fcfcf2326c3b05f53079b09fe53bd36d826a7de7d3d4da487476245bb184d` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 1 | 1 | `ce0e5118ce377d4c80197b92115832e0bc40a7ceedffbd92286141803f81414c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 0 | `69fdb0c35a36b6d22a7e3da01178aed083272df60ee82a1cfad4617b104f2749` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `b612196f6d521c6ed462ff2e69d9427cc3d35fd520bba9107f34e6c1171b1cb1` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r5efdc136f237/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `9e410eec9f9fe2c55c06d7fa4fce690b17bc646f6224f6d767ecfc732d08f5d1` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 2 | 0 | `001cb0e73b2f4ed81c6a0a4710fce613fad90cdd6a72cffa01507c5b1dea8750` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 0 | `69fdb0c35a36b6d22a7e3da01178aed083272df60ee82a1cfad4617b104f2749` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `33fe61571e2a4d4e7bc57098379e5b7ed21cd19974cb4d05348086bd6bf8516c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r6930a1922fdc/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `b15436221b12a2d879421e41b448824d7108742f47e1305b1f12f1eab5c7ba04` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 2 | 0 | `001cb0e73b2f4ed81c6a0a4710fce613fad90cdd6a72cffa01507c5b1dea8750` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 0 | `69fdb0c35a36b6d22a7e3da01178aed083272df60ee82a1cfad4617b104f2749` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `33fe61571e2a4d4e7bc57098379e5b7ed21cd19974cb4d05348086bd6bf8516c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r78d4eab2e727/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `b15436221b12a2d879421e41b448824d7108742f47e1305b1f12f1eab5c7ba04` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 2 | 0 | `001cb0e73b2f4ed81c6a0a4710fce613fad90cdd6a72cffa01507c5b1dea8750` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 0 | `69fdb0c35a36b6d22a7e3da01178aed083272df60ee82a1cfad4617b104f2749` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `33fe61571e2a4d4e7bc57098379e5b7ed21cd19974cb4d05348086bd6bf8516c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `6ac832ca76ac15b29fa26eca6d4d51c0b59927db1c0860796abe4829b57f0f43` |
| `D:evolution/experiments/EXP-security-operations-expert-027-f-r92ea65e6316b/candidate/dsh/workspace/.agents/skills/xx-device-control` | 当前工作树 | 1 | 0 | `bd01a483547b6f52d9f6fc97f4682fb7633eca2990c8a00e3f3fd77b96d775dd` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/emergency-action` | 当前工作树 | 1 | 0 | `05bf6a8a37b4f6ce0744d1134a2cf91172dd5f5cb3c336caa7e9839eee8b82dc` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/fault-analysis` | 当前工作树 | 1 | 0 | `84c089f2e2de2f2d1ce814e2cebb7d86b90a1dc64936b87bfd5dd23691e597b6` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/playbook-impact-assessment` | 当前工作树 | 1 | 1 | `ecd321abf736b4984a6f0b4132831a2e4fe547971d656fc9e782e495930a4815` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/policy-configuration` | 当前工作树 | 2 | 0 | `001cb0e73b2f4ed81c6a0a4710fce613fad90cdd6a72cffa01507c5b1dea8750` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/response-planning` | 当前工作树 | 1 | 1 | `4a51293997ee6fbba54ab7c5b7f800f80778f2d4aace01e197cfcad73cd4439c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/security-inspection` | 当前工作树 | 1 | 0 | `69fdb0c35a36b6d22a7e3da01178aed083272df60ee82a1cfad4617b104f2749` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/security-investigation` | 当前工作树 | 1 | 0 | `33fe61571e2a4d4e7bc57098379e5b7ed21cd19974cb4d05348086bd6bf8516c` |
| `D:evolution/experiments/EXP-security-operations-expert-027-m-reab20c48f610/candidate/dsh/workspace/.agents/skills/threat-analysis` | 当前工作树 | 1 | 0 | `b15436221b12a2d879421e41b448824d7108742f47e1305b1f12f1eab5c7ba04` |
| `P:.agents/skills/ai-correction-log` | 当前工作树 | 2 | 1 | `fe3a58b124b8bed0a4cc43cb50a76a2425fc7d949ffa0cfd5554b547b619440e` |
| `P:.agents/skills/continuous-dev-progress-vs-project-vision-gap-assessment` | 当前工作树 | 3 | 0 | `fdfafc4b61d22fdef22466027b31c04ae22e8998260582698c4674e87eb628ba` |
| `P:.agents/skills/dsh-platform-development` | 当前工作树 | 1 | 8 | `1cd113fd4947f9c08d8326ed644260a466e9eb3c88ed86650f0f661bb77dc1b2` |
| `P:.agents/skills/dsh-platform-task-list` | 当前工作树 | 2 | 0 | `989370eb27ba6325028026b78a81c2ff839f5e5cfd6ee8e1e5ec822429ae7d53` |
| `P:.agents/skills/reviewing-agent-skills` | 当前工作树 | 7 | 3 | `1d4de7b4a13f0b70de84d482a69bf2db752ff1bd0517db887b0a1a109a9c656b` |
