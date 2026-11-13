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

`platform/hep-lab` 在源码工作区内直接执行核心 CLI；`platform/hep-lab bootstrap` 或 `platform/hep-lab-bootstrap.sh` 是独立 Bootstrap 入口。Bootstrap 自身只依赖 Node.js 24、Git 和 pnpm（已有缓存时不重复安装依赖），不要求先进入平台源码目录。

Bootstrap 流程固定程序仓库和数据仓库提交，下载并校验程序 CLI，从数据仓库 `locks/repositories.yaml` 解析四个仓库的 URL 与完整 SHA，然后调用核心 `init`：

1. 检查 Node.js 24、Git、pnpm/corepack 和目标路径；
2. 按完整 SHA 缓存程序仓库与数据仓库；
3. 读取数据锁定文件中的平台、DSH Home、业务智能体仓库来源；
4. 调用 `hep-lab init` 检出四个仓库并写入 `hep-lab.yaml`；
5. 输出 `doctor` 和平台启动命令；指定 `--start` 时先执行 `prepare` 再启动平台。

Bootstrap 不执行可变 `main` 分支脚本，也不把凭据放在命令行参数或日志中。受控升级可通过环境变量替换固定程序/数据 SHA，并由数据仓库锁定文件继续校验四仓库来源。

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
