import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const require = createRequire('/opt/dsh/packages/preset/agent-preset-registry/package.json')
const { load } = require('js-yaml')
const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
const { defineTool } = await import(pathToFileURL('/opt/dsh/packages/core/tools/lib/index.js').href)
const Native = await import(pathToFileURL('/opt/dsh/packages/subagent/tool-subagent/lib/index.js').href)
export const name = 'legacy-foreground-delegate'
export const inject = [...Native.inject, 'agentPresets']

/** 用公开的原生子 Preset 与 caller activation 保留已固定旧 Harness 的前台委派合同。 */
export async function apply(ctx: any, config: any) {
  if (!Object.hasOwn(config, 'persona') && !Object.hasOwn(config, 'toolFilter')) {
    return Native.apply(ctx, Native.Config(config))
  }
  if (config.provider !== 'spawn' || config.enableRunInBackground !== false
    || config.backgroundMode !== 'one-shot' || typeof config.persona !== 'string'
    || !Array.isArray(config.toolFilter?.allow) || Object.keys(config.toolFilter).some(key => key !== 'allow')) {
    throw new Error('Only fixed foreground spawn delegates with an allow filter support rc.2 projection')
  }
  const target = process.env.DSH_EVAL_TARGET_PRESET
  if (!target) throw new Error('Legacy delegate requires DSH_EVAL_TARGET_PRESET')
  const toolName = config.toolName ?? 'subagent'
  const childPreset = `dsh-compat-${target}-${toolName.replaceAll('_', '-')}`
  const document = await ctx.agentPresets.readDocument(target)
  const plugins = load(document.content, { schema: entryListSchema })
  let replaced = false
  const childPlugins = plugins.map((entry: any) => {
    if (entry.id === 'persona') {
      replaced = true
      return { ...entry, config: { prefix: config.persona } }
    }
    if (entry.name === 'cordis:include' && isAbsolute(entry.config?.path ?? '')) {
      const included = load(readFileSync(entry.config.path, 'utf8'), { schema: entryListSchema })
      if (included.some((row: any) => row.id === 'persona')) {
        replaced = true
        return { ...entry, config: { ...entry.config, patches: [...entry.config.patches ?? [],
          { id: 'persona', config: { prefix: config.persona } }] } }
      }
    }
    return entry
  })
  if (!replaced) throw new Error('Legacy delegate target has no directly patchable persona')
  childPlugins.push({ id: 'legacy-child-filter', name: '/opt/dsh-adapter/schedule-compat/child-filter.ts',
    config: { allow: [...config.toolFilter.allow] } })
  await ctx.effect(async () => ctx.agentPresets.register({ id: childPreset,
    description: `Runtime 兼容子角色：${toolName}`, plugins: childPlugins }))
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a separate child agent and wait for its final result.',
    parameters: {
      cwd: { type: 'string', description: 'Optional child working directory.' },
      description: { type: 'string', required: true, description: 'Short description of the delegated task.' },
      prompt: { type: 'string', required: true, description: 'Complete self-contained task for the child.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, const: 'foreground' },
      runId: { type: 'string', required: true },
      output: { type: 'array', required: true, items: { type: 'json' } },
    } }, render: (_args: any, value: any) => value.output },
    isConcurrencySafe: () => true,
    async execute(args: any, exec: any) {
      if (!exec.agent) throw new Error('Legacy delegate requires a live parent Agent')
      const run = await ctx.subagents.startActivation({ provider: config.provider, label: args.description,
        request: { parent: exec.agent, prompt: [{ type: 'text', text: args.prompt }], agentPreset: childPreset,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
          maxDepth: ctx.subagents.resolveMaxDepth(config.maxDepth) }, signal: exec.signal, delivery: 'caller' })
      const cancel = () => { void run.dispose().catch(() => undefined) }
      exec.signal.addEventListener('abort', cancel, { once: true })
      if (exec.signal.aborted) cancel()
      let executionError: unknown
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error(`Subagent stopped: ${result.stopReason}`)
        // 新原生生命周期以 childId 为稳定身份；仅在旧 foreground 回执中使用 runId 字段。
        return { kind: 'foreground', runId: run.childId, output: result.output }
      } catch (error) {
        executionError = error
        throw error
      } finally {
        exec.signal.removeEventListener('abort', cancel)
        try { await run.dispose() }
        catch (cleanupError) {
          if (executionError !== undefined) throw new AggregateError([executionError, cleanupError], 'Subagent execution and cleanup failed')
          throw cleanupError
        }
      }
    },
  }))
}
