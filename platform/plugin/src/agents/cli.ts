import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createAgentsHandler } from './index.ts'
import { defaultAssetRoot } from '../workspace.ts'

// 与页面和助手共用智能体及版本入口；不另建迁移、创建或融合实现。
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'asset-root': { type: 'string' }, input: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    process.stdout.write('用法：node --experimental-transform-types platform/plugin/src/agents/cli.ts <action> --asset-root <数据根> [--input <JSON文件或->]\n新建智能体：new，输入 agent_id、name、description、role，可选 profile、evaluation_cases；版本派生：create。\n迁移预览：versions/migration-plan；确认：versions/migration-apply，输入 confirmed 与 expected_plan_sha256。\n融合跨进程确认：fusion/confirm，输入原 preview 请求及 confirmed、expected_plan_sha256。\n')
  } else {
    if (positionals.length !== 1) throw new Error('须指定一个 agents action；使用 --help 查看用法')
    if (!/^(?:list|detail|new|create|fusion\/(?:preview|proposal|confirm|status|verify|finalize)|versions\/migration-(?:plan|apply))$/.test(positionals[0]!)) throw new Error('CLI 仅提供智能体与版本领域入口')
    const input = values.input ? JSON.parse(readFileSync(values.input === '-' ? 0 : values.input, 'utf8')) : {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('输入须为 JSON 对象')
    // 本地版本动作不使用连接 peer；SDK、部署等依赖连接身份的动作不在 CLI 范围。
    const result = await createAgentsHandler(resolve(values['asset-root'] ?? defaultAssetRoot()))(positionals[0]!, input, new AbortController().signal, undefined!)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.ok) process.exitCode = 1
  }
} catch (error) {
  // 不回显输入，避免错误 JSON 或参数携带凭据。
  process.stderr.write(error instanceof SyntaxError ? '输入 JSON 无效\n' : 'CLI 调用失败，请核对 action、数据根与输入文件\n')
  process.exitCode = 1
}
