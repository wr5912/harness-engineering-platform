# TypeScript SDK 无界面智能体验证

关联 `PA-04/05/06/08/09/12/13`。业务身份、Preset 与版本合同继续复用；本记录是平台与工具链验证，不是业务 Evaluation 或 Research Release。

## 原生页面与真实模型

隔离平台使用独立工作区、HOME 和本机原生 DSH。实际页面完成新建 SDK 型版本、提交任务、刷新回读、选择同一 Session 继续对话、查看接入文档和 TypeScript 示例。`mimo-v2.6-flash` 返回“SDK真实模型调用正常。”，恢复后的同一 Session 能原样回忆该回复。实例完成后正常退出，没有业务监听端口；390px 文档及实例页无横向溢出，页面脚本错误为零。机器回执见 [native-result.json](native-result.json)，页面见[完成结果](native-completed.png)、[窄屏指南](native-guide-mobile.png)和[实例状态](native-instance-mobile.png)。

本地 Qwen 端点在宿主机和容器中均超时，DeepSeek 返回余额不足；两次实际失败均在隔离工作区操作记录中保留，没有计为通过。后续成功使用另一条已有模型配置，没有修改原业务工作区的默认模型。

## 标准镜像与独立离线包

原生技术适配器的确定性输入验证了主 Preset、新建及持久会话恢复、子 Preset 委派后的根汇总、TypeScript 裸包名示例、准备取消和容器停止。模型替身只替换模型接口，DSH、官方 SDK、Preset、容器和持久化均真实执行。

AMD64 v2 包实际执行归档、解包、原 `install.sh`、`docker load`，没有跳过镜像导入或重建镜像。安装后 `prepare-sdk` 生成可读选项且不创建 Session；随后新建、同 Session 恢复及包内版本 TypeScript 示例通过，来源指南与示例字节和摘要一致。临时容器均已停止、未发布端口，HOME 保留。包摘要、来源快照与完整检查见 [offline-result.json](offline-result.json)。v2 明确区分此前修复前的包，没有覆盖旧包或回执。

## 提交候选检查

首轮在合入远端 `cea0fcc` 且排除并行未提交迁移与研究改动的独立检出中，TypeScript 检查与构建通过；插件全量 **1291/1291**、部署全量 **86/86**、Runtime Python **163/163**、Runtime Node **9/9** 通过，均无跳过。专项代码审查发现的六项生命周期、来源与交互问题修复后，独立复核 **50/50** 通过；Chromium 组件验证共九项通过。

随后远端 `df39eed` 已包含正式迁移与角色装载提交，保留双方功能后重新构建并补验：Runtime Python **179/179**、Runtime Node **24/24**、部署 **86/86**，Chromium 组件九项通过、页面脚本错误为零。插件全量 **1335/1336**，唯一失败来自测试按隔离目录导入模块，却与指定全局 Runtime 的另一份模块比较引用。测试改为从实际 Runtime 解析全部期望模块，原引用恒等、消息冻结与输出校验断言保留；对应构建及依赖测试文件修复后 **15/15** 通过。全量与复测均无跳过，没有遗留未修复失败。整合日志分别为 `release-integrated-plugin-tests.log` 和 `release-integrated-build-tests.log`。

此前失败与环境差异的原始日志保存在本机 `.local/sdk-verification/`；最终插件日志为 `release-validated-plugin-tests.log`，依赖使用独立目录，避免符号链接影响现有编译来源校验。上述结果没有替代原生页面、真实模型和完整离线安装的分别验证。

## 适用边界

真实页面使用本轮工作树实现；提交候选另外在独立检出中构建、测试，并保留远端已提交的迁移与研究改动。具体机器测试结果以项目验收矩阵及本机 `.local/sdk-verification/` 日志为准。

完整离线安装验证限定本机 AMD64、已有 Docker 和确定性模型适配器；未验证 ARM64、缺 Docker 新系统、任意第三方 MCP 或真实业务质量。独立包与平台真实模型是两组分别执行的证据。18120 未重载；其运行服务保留原 Web 创建入口，新功能在隔离平台验证。隔离验证平台已定向停止，资产、HOME、会话与证据保留。
