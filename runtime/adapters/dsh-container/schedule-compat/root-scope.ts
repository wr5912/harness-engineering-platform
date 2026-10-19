import { pathToFileURL } from 'node:url'

export const name = 'schedule-root-scope'
export const inject = ['tools', 'agents', 'agentPresets']

/** 保留旧 bundle 的全局根工具；原生工具拒绝子 Agent，既有 Guard 继续收紧目录。 */
export async function apply(ctx: any) {
  const tools = await import(pathToFileURL('/opt/dsh/packages/schedule/tool-schedule/lib/index.js').href)
  await ctx.plugin(tools, {})
  ctx.on('agent/created', ({ agent }: { agent: any }) => clockForAgent(ctx, agent))
}

export async function clockForAgent(ctx: any, agent: any) {
  const header = agent.session.header
  const preset = ctx.agentPresets?.composedPreset(agent.ctx) ?? header.agentPreset
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    || preset !== process.env.DSH_EVAL_TARGET_PRESET) return
  const clock = await import(pathToFileURL('/opt/dsh/packages/context/time-context/lib/index.js').href)
  await agent.ctx.plugin(clock, {})
}
