/** 在官方 SDK 创建根 Agent 时装载版本固定的业务 Preset。 */
export const name = 'harness-sdk-preset'
export const inject = ['agentPresets', 'sessionProjections']

export function apply(ctx: any, config: { presetId: string }): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.presetId)) throw new Error('SDK 主 Preset ID 无效')
  ctx.on('agent/created', async ({ agent, source }: any) => {
    if (agent.session.header.parentSession !== undefined) return
    if (source === 'resume') {
      const recorded = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
      if (recorded !== config.presetId) throw new Error('SDK 会话的持久 Preset 与当前版本不一致')
      await ctx.agentPresets.mount(agent.ctx, recorded)
    } else {
      await ctx.agentPresets.select(agent, config.presetId)
    }
  }, { prepend: true })
}
