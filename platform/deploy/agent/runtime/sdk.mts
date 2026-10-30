import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectHarnessPresets } from '../../../plugin/src/models/harness-runtime.ts'
import { agentCandidateDigest } from '../snapshot.mts'
import type { AgentSourceSnapshot } from '../types.mts'

/** 运行投影只读取已核对的来源；源字节变化时拒绝混合生成安装包。 */
export function stageSdkRuntime(staging: string, programRoot: string, snapshot: AgentSourceSnapshot): void {
  const root = join(staging, 'runtime')
  mkdirSync(root, { recursive: true })
  for (const name of ['sdk-runner.mts', 'sdk-preset.mts', 'sdk-profile.patch.yml', 'sdk-module-links.mts', 'prepare-verification-home.mjs']) {
    const source = join(programRoot, 'runtime/adapters/dsh-container', name)
    if (!existsSync(source)) throw new Error(`SDK 运行组件缺失：${name}`)
    cpSync(source, join(root, name))
  }
  if (snapshot.source.harness_runtime) {
    const binding = join(programRoot, 'platform/plugin/lib/model-binding-runtime.js')
    if (!existsSync(binding)) throw new Error('角色模型绑定运行器未构建，请构建平台插件后重试')
    cpSync(binding, join(root, 'model-binding-runtime.js'))
    projectHarnessPresets(snapshot.candidate, join(root, 'projections/presets'), snapshot.source.harness_runtime)
  }
  if (agentCandidateDigest(snapshot.candidate) !== snapshot.candidateSha256) throw new Error('版本资产在 SDK 投影期间变化，请重新导出')
  // SDK 接入内容来自版本快照；这里只维护独立安装器的运行入口说明。
  writeFileSync(join(staging, 'SDK使用说明.md'), `# SDK 独立包运行

所选版本的接入说明见 [sdk/README.md](sdk/README.md)，调用示例见 [sdk/example.ts](sdk/example.ts)。两者按来源原始字节保存。

## 安装与调试

运行 \`./install.sh --prefix <空目录>\` 安装。安装只准备运行环境，不自动提交任务。
将输入保存为 JSON 文件，例如 \`{"input":"请介绍你的职责。"}\`，再运行 \`./agent run --input-file <JSON文件>\`。显式恢复会话时，在同一 JSON 中增加 \`session_id\`。
运行 \`./agent logs\` 查看当前执行，\`./agent stop\` 停止整个 SDK 应用；下一次执行复用原 HOME。退出码为零表示技术执行结束，业务结果仍须按实际任务核对。

## 应用集成

\`./agent prepare-sdk\` 初始化同一标准镜像内的 SDK 环境。\`./agent example '你的输入'\` 执行 \`sdk/example.ts\` 的可运行副本；应用使用镜像内同版本 SDK，不另装 DSH。
运行选项位于容器的 \`/var/lib/dsh/standalone/sdk-options.json\`，通过 \`HARNESS_SDK_OPTIONS\` 提供。Harness、Preset 和插件保持只读，应用工作目录与 Session 在 HOME 内持久保存。SDK 调用、会话与能力边界以版本接入说明为准。

模型和 MCP 重新配置沿用 \`./agent configure --config-file <JSON>\`。LLM API Key 仅保存在专用忽略文件中，不写入示例或普通日志。

`)
}
