import { assetAlertsFlow } from './asset-alerts.ts'
import { createThreatRuntime } from './threat/index.ts'
import { createNativeThreatServices } from './threat-services.ts'
import { seedThreatCompositions } from './templates.ts'
import { createSoc } from './soc.ts'
import { diagnosticProposalService } from './diagnostic-services.ts'
import workflowFactories from '@mcp/workflows'
import type { CompositionExtension } from '@harness-platform/mcp/extension'
import { lfxWorkflow } from '@harness-platform/mcp/lfx-runtime'
declare const __MCP_BUILD_DIGEST__: string
declare const __WORKFLOW_DIGESTS__: Record<string, string>

export const name = 'security-operations-compositions'
export const inject = ['platformMcp', 'llm', 'settingsController']

export function apply(ctx: any) {
  const root = process.env.HARNESS_ASSET_ROOT
  if (!root) throw new Error('未设置 HARNESS_ASSET_ROOT')
  const extension: CompositionExtension = ctx.platformMcp.compositionExtension
  if (extension.id) throw new Error('组合编排业务扩展已登记')
  const dispatch = (request: any, signal?: AbortSignal) => ctx.platformMcp.dispatch(request, signal)
  const servers = () => ctx.platformMcp.servers.get()
  const soc = Object.assign(createSoc(dispatch, servers), { propose: diagnosticProposalService(ctx.llm,
    () => ctx.settingsController.describe().namespaces.find((item: any) => item.ns === 'agent-default-model')?.value) })
  const workflows = Object.fromEntries(Object.entries(workflowFactories)
    .map(([id, create]) => [id, lfxWorkflow(root, id, { ...create(soc), sourceDigest: __WORKFLOW_DIGESTS__[id] }, soc)]))
  const threat = createThreatRuntime(root, createNativeThreatServices(root, dispatch, ctx.llm,
    () => ctx.settingsController.describe().namespaces.find((item: any) => item.ns === 'agent-default-model')?.value, servers))
  ctx.effect(() => {
    Object.assign(extension, { id: name, sourceDigest: __MCP_BUILD_DIGEST__, threat, workflows, flow: assetAlertsFlow, seed: seedThreatCompositions })
    return () => { for (const key of ['id', 'sourceDigest', 'threat', 'workflows', 'flow', 'seed'] as const) delete extension[key] }
  })
}
