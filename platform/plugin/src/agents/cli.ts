import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

// 与页面和助手共用智能体及版本入口；不另建迁移、创建或融合实现。
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'asset-root': { type: 'string' }, input: { type: 'string' }, 'request-id': { type: 'string' },
    'operation-id': { type: 'string' }, help: { type: 'boolean' }, json: { type: 'boolean' },
  } })
  if (values.help) {
    process.stdout.write('用法：node --experimental-transform-types platform/plugin/src/agents/cli.ts <action> --asset-root <数据根> [--input <JSON文件或->] [--request-id <id>] [--operation-id <id>] [--json]\n动作直接映射 createAgentsHandler，覆盖 list/detail/new/create、assets/edit/cases/eval/runs/decision、compute-variants、migrations、fusion、features、research、tasks 和 sdk；写操作继续由现有 CAS、锁和确认合同约束。\n')
  } else {
    if (positionals.length !== 1) throw new Error('须指定一个 agents action；使用 --help 查看用法')
    if (!/^(?:list|description|detail|new|create|(?:assets|edit|cases|eval|runs|decision|compute-variants|migrations|fusion|features|research|tasks|sdk|versions|legacy|documents)(?:\/|$).+)$/.test(positionals[0]!)) throw new Error('不支持的 agents action；使用 --help 查看可用动作')
    const input = values.input ? JSON.parse(readFileSync(values.input === '-' ? 0 : values.input, 'utf8')) : {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('输入须为 JSON 对象')
    const request = { ...(input as Record<string, unknown>) }
    if (values['request-id'] !== undefined) request.request_id ??= values['request-id']
    if (values['operation-id'] !== undefined) request.operation_id ??= values['operation-id']
    const { createAgentsHandler } = await import('./index.ts')
    const { defaultAssetRoot } = await import('../workspace.ts')
    const result = await createAgentsHandler(resolve(values['asset-root'] ?? defaultAssetRoot()))(positionals[0]!, request, new AbortController().signal, undefined!)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.ok) process.exitCode = 1
  }
} catch (error) {
  // 不回显输入，避免错误 JSON 或参数携带凭据。
  process.stderr.write(error instanceof SyntaxError ? '输入 JSON 无效\n' : 'CLI 调用失败，请核对 action、数据根与输入文件\n')
  process.exitCode = 1
}
