export interface WorkflowModelBinding {
  provider: string
  model: string
  reasoning_effort: string
  checkpoint_sha256?: string
  state_constructor_sha256?: string
  calibration_sha256?: string
}
export interface WorkflowModelRoles {
  language: WorkflowModelBinding
  decision: WorkflowModelBinding & { checkpoint_sha256: string; state_constructor_sha256: string; calibration_sha256: string }
}

const DIGEST = /^[0-9a-f]{64}$/
const fields = ['provider', 'model', 'reasoning_effort'] as const
const artifacts = ['checkpoint_sha256', 'state_constructor_sha256', 'calibration_sha256'] as const

/** 角色绑定在运行前固定；决策服务的权重、状态构造器及校准同属模型身份。 */
export function validateWorkflowModelRoles(value: any): value is WorkflowModelRoles {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'decision,language'
    && ['language', 'decision'].every(role => value[role] && typeof value[role] === 'object'
      && Object.keys(value[role]).every(key => [...fields, ...artifacts].includes(key as any))
      && fields.every(field => typeof value[role][field] === 'string' && value[role][field].trim() === value[role][field] && value[role][field].length > 0)
      && artifacts.every(field => value[role][field] === undefined ? role === 'language' : DIGEST.test(value[role][field])))
    && (value.language.provider !== value.decision.provider || value.language.model !== value.decision.model)
}

export function matchesWorkflowModelBinding(route: any, binding: WorkflowModelBinding): boolean {
  return fields.every(field => route?.[field] === binding[field])
    && artifacts.every(field => binding[field] === undefined || route?.[field] === binding[field])
}
