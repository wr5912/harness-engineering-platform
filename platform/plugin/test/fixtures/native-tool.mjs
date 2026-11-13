export async function executeNative(ctx, { name, arguments: args = {}, callId = 'test-call', ...identity }) {
  const toolSet = await ctx.tools.resolve({ ...identity, modelSelection: identity.modelSelection ?? { provider: 'offline-test', model: 'test' } })
  try {
    const batch = await ctx.tools.execute({ ...identity, toolSet, calls: [{ id: callId, name, arguments: JSON.stringify(args) }] })
    return batch.results[0].result
  } finally { toolSet.dispose() }
}
