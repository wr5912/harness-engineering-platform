import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.ok(process.env.HARNESS_DSH_ENTRY, '请指定锁定 Runtime 的 HARNESS_DSH_ENTRY')
assert.ok(process.env.HARNESS_ASSET_ROOT, '请指定 HARNESS_ASSET_ROOT')
const require = createRequire(resolve(process.env.HARNESS_DSH_ENTRY))
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { ToolRuntime }, { SystemPrompt }, { createMcpToolDefinition }, { createScope }] =
  await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt', 'dsh-mcp-client', 'dsh-scope'].map(load))
const { apply } = await import(pathToFileURL(resolve(process.env.HARNESS_ASSET_ROOT,
  'evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/managed/security-operations-guard.mjs')).href)
const ctx = new Context(), hooks = new Map()
let authenticated = true, scopedParent
const services = ctx.plugin({ apply(inner) {
  new SystemPrompt(inner, {})
  new ToolRuntime(inner, { mode: 'native' })
  inner.provide('businessRuntime', { requiresAuthentication: () => authenticated })
} })
await services
const injected = ctx.plugin({ inject: ['tools'], apply(inner) { scopedParent = inner } })
await injected
const agent = { session: { header: { delegationDepth: 0 } } }, scope = createScope(scopedParent, agent)
agent.ctx = scope.ctx
const register = name => ctx.tools.register(createMcpToolDefinition(ctx, {
  name, rawName: name, description: 'fixture', inputSchema: { type: 'object', properties: {} }, call: async () => ({ content: [] }),
}))
register('skill')
register('mcp__unrelated__read')
apply({ get: ctx.get.bind(ctx), tools: ctx.tools, logger: { warn: console.warn }, on: (name, hook) => hooks.set(name, hook),
  mcpSessionManager: { resolveTool: (source, raw) => `mcp__${source}__${raw}` } })
const step = value => hooks.get('agent/pre-step')({ agent, step: value, messages: [] }, async () => {})
try {
  await step(1)
  assert.equal(ctx.tools.get('mcp__unrelated__read', agent), undefined)
  const inspection = 'mcp__inspection-compositions__inspection_routine'
  register(inspection)
  assert.equal(ctx.tools.get(inspection, agent), undefined)
  await step(2)
  assert.ok(ctx.tools.get(inspection, agent))
  assert.equal(ctx.tools.get('mcp__unrelated__read', agent), undefined)
  authenticated = false
  await step(3)
  assert.ok(ctx.tools.get('mcp__unrelated__read', agent))
  console.log(JSON.stringify({ lateMcpVisible: true, authenticatedScopePreserved: true, anonymousRestrictionLifted: true }))
} finally {
  await scope.dispose()
  await ctx.fiber.dispose()
}
