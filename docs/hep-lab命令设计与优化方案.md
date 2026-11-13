# hep-lab 命令设计与优化方案

## 目标

`hep-lab` 只负责创建和检查一个可复现的四仓库工作区。工作区使用单一目录布局，运行时直接使用工作区内的 DSH Home 和业务智能体仓库，不创建额外的隔离 worktree。

## 固定目录合同

```text
<destination>/
├── hep-lab.yaml
├── harness-engineering-platform/
├── harness-engineering-platform-data/
├── platform-manager-dsh-home/
└── business-agents/
```

`hep-lab.yaml` 的 `paths.dsh_home` 固定指向 `platform-manager-dsh-home/`，`paths.business_agents_root` 固定指向 `business-agents/`。清单使用 `initializer_version: 2`；旧的 `.hep-lab/manifest.yaml` 或隔离运行时清单不自动迁移或删除。

## 命令边界

```text
hep-lab init      检查输入、按锁定 SHA 检出四个仓库并写入清单
hep-lab status    检查四个仓库当前提交、工作树和锁定提交
hep-lab doctor    检查仓库、来源锁、业务注册、DSH Profile 和运行兼容性
hep-lab update    只生成远端更新计划，不直接修改仓库
```

`init` 默认要求完整 commit。`--allow-floating-ref` 只用于开发环境，解析后仍把实际 SHA 写入清单。已有工作树必须使用 `--reuse`，并且 origin、提交和工作树都必须一致且干净。任何不属于四个仓库或 `hep-lab.yaml` 的顶层内容都会拒绝写入。

## 已移除的运行隔离选项

不再提供 `--isolate-runtime`，也不再生成 `.hep-lab/`、Git worktree 或 `runtime.isolation` 清单字段。这样可以避免同一工作区存在两套业务源码入口和两套 DSH Home 路径，减少来源、状态和实际装载路径不一致的可能。

检测到旧的 `.hep-lab/` 目录时，初始化直接停止并要求先由操作者清理；不会自动删除运行数据或 worktree。旧 `initializer_version: 1` 清单需要重新初始化。

## 独立安装与一键初始化

源码入口 `platform/hep-lab` 依赖同仓库的 `tool-env.sh`、`platform/lab` 和插件依赖，不能作为单个 raw 文件直接执行。正式的一键流程应提供固定版本的 bootstrap 安装器：

1. 下载或安装固定版本的 `hep-lab` CLI；
2. 校验发布包的 SHA-256 或签名；
3. 检查 Node.js 24、pnpm、Git 和认证；
4. 从数据仓库锁定文件解析四个仓库的来源和提交；
5. 调用 `hep-lab init --destination "$HOME/hep-lab"`；
6. 输出清单路径、四个仓库 SHA 和下一步的 `status`/`doctor` 命令。

bootstrap 不应直接执行可变的 `main` 分支脚本，也不应把凭据放在命令行参数或日志中。README 同时保留源码仓库内运行方式和独立安装方式，并明确两者的依赖与版本边界。

## 验收要求

- `--help` 不再出现 `--isolate-runtime`。
- 使用固定 SHA 初始化后，四个仓库均存在且处于对应 detached commit。
- 清单为 `initializer_version: 2`，不存在 `runtime` 字段。
- 清单文件位于目标根目录的 `hep-lab.yaml`。
- `paths.dsh_home` 和 `paths.business_agents_root` 均指向顶层仓库。
- 初始化不会创建 `.hep-lab/` 或 Git worktree。
- 缺少 commit、锁定冲突、origin 不一致、脏工作树和非空目标目录均在写入前失败。
- `status`、`doctor`、`update --plan-only` 能读取新清单。
- 旧隔离目录不会被静默删除；错误信息能指导人工清理或重新初始化。
- CLI 单元测试、工作区测试、类型检查和仓库合同检查全部通过。
