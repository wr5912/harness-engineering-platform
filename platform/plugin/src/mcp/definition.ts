import type { CompositionConfig } from './compositions.ts'
import type { CompositionExtension } from './extension.ts'

export const INCIDENT_ID_PATTERN = '^INC-\\d{8}-\\d{6}$'
export const RUN_ID_PATTERN = '^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
export const compositionQueries = [
  { toolName: 'get_composition_run', title: '查询组合运行', description: '按原运行 ID 查询进度、已完成检查、明细和报告清单；不会重新执行。', inputSchema: { type: 'object', properties: { run_id: { type: 'string', pattern: RUN_ID_PATTERN } }, required: ['run_id'], additionalProperties: false } },
  { toolName: 'get_composition_artifact', title: '读取组合报告', description: '读取原运行已生成的 HTML 或 JSON 报告。', inputSchema: { type: 'object', properties: { run_id: { type: 'string', pattern: RUN_ID_PATTERN }, artifactId: { type: 'string', minLength: 1 } }, required: ['run_id', 'artifactId'], additionalProperties: false } },
  { toolName: 'get_composition_details', title: '分页查询检查明细', description: '按原运行和节点 ID 分页读取已完成的检查事实，不重新执行。节点 ID 从运行查询取得。', inputSchema: { type: 'object', properties: { run_id: { type: 'string', pattern: RUN_ID_PATTERN }, node_id: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, required: ['run_id', 'node_id'], additionalProperties: false } },
] as const

export function compositionInputSchema(config?: CompositionConfig, extension?: CompositionExtension): Record<string, any> {
  if (config?.workflow) {
    const workflow = extension?.workflows?.[config.workflow]
    if (!workflow) throw new Error(`工作流尚未装载：${config.workflow}`)
    return workflow.inputSchema
  }
  if (config?.kind) {
    const collect = config.kind === 'composite' || config.stage === 'collect'
    const key = collect ? 'incident_id' : 'run_id'
    return { type: 'object', properties: { [key]: { type: 'string', description: collect ? 'SOC 事件 ID，例如 INC-20261015-000001' : '前序阶段返回的运行 ID', pattern: collect ? INCIDENT_ID_PATTERN : RUN_ID_PATTERN } }, required: [key], additionalProperties: false }
  }
  const schema = compositionDefinition.inputSchema
  return config?.flow ? { ...schema, properties: { ...schema.properties,
    asset: { type: 'string', description: 'SOC 正整数资产 ID，例如 9106', pattern: '^[1-9]\\d*$' },
  } } : schema
}

export function compositionReadonly(config?: CompositionConfig) { return config?.readonly ?? (!config?.kind || Boolean(config.workflow)) }

export function compositionOutputSchema(config?: CompositionConfig, extension?: CompositionExtension): Record<string, any> {
  if (config?.workflow) return extension?.workflows?.[config.workflow]?.outputSchema ?? { type: 'object' }
  if (!config?.kind) return compositionDefinition.outputSchema
  return { type: 'object', properties: {
    run_id: { type: 'string' }, incident_id: { type: 'string' }, status: { type: 'string' }, phase_status: { type: 'string' },
    route: { type: 'string' }, judgement_id: { type: 'string' }, artifacts: { type: 'array', items: { type: 'object' } },
    trace: { type: 'array', items: { type: 'object' } },
    ...(config.kind === 'composite' ? { stepValues: { type: 'object', description: '已实际执行的子组合结果；全部跳过时为空，工具返回失败。' } } : {}),
  }, required: config.kind === 'composite' ? ['stepValues', 'trace'] : ['run_id', 'incident_id', 'status', 'phase_status', 'artifacts', 'trace'] }
}

export const compositionDefinition = {
  schema_version: '1.0',
  readonly: true,
  inputSchema: {
    type: 'object',
    properties: {
      asset: { type: 'string', description: '资产 ID、主机名或 IP' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    },
    required: ['asset'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      asset: { type: 'object' },
      alerts: { type: 'array', items: { type: 'object' } },
      alertSummary: { type: 'object', description: 'SOC 告警分组的查询范围、总分组数及总告警数；alerts 为首页分组' },
      trace: { type: 'array', items: { type: 'object' } },
    },
    required: ['asset', 'alerts', 'trace'],
  },
  upstream: {
    kind: 'openapi',
    operations: ['get_asset', 'list_alerts'],
  },
} as const
