export const name = 'legacy-prompt-variables'
export const inject = ['systemPrompt', 'workingDirectory']

/** 保留旧固定 Persona 的 cwd 模板；值来自当前 Agent 的原生工作目录事实。 */
export function apply(ctx: any) {
  ctx.systemPrompt.variable('cwd', ({ agent }: { agent?: any }) => agent
    ? ctx.workingDirectory.get(agent.session) : undefined)
}
