export const name = 'legacy-child-filter'
export const inject = ['tools', 'agents']

/** 在最终 Agent 层约束祖先 Preset 的 MCP 工具；执行检查同时覆盖后续发现的工具。 */
export function apply(ctx: any, config: { allow: string[] }) {
  const allowed = new Set(config.allow)
  ctx.on('agent/created', ({ agent }: { agent: any }) => {
    agent.ctx.tools.restrict({ allow: config.allow.filter(name => ctx.tools.get(name, agent) !== undefined) })
  })
  ctx.tools.guard((exec: any) => allowed.has(exec.name) ? undefined : 'Legacy child tool filter denied this tool')
}
