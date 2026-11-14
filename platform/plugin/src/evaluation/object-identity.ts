import { isVariantIdentity } from '../version-id.ts'

export type EvaluationExperiment = {
  id: string
  agent_id?: string
  is_variant?: boolean
  status?: string | null
  change?: Record<string, any>
}

export function evaluationObjectType(id: string, experiments: EvaluationExperiment[]): '智能体' | '变体' | '待核对' {
  if (id.startsWith('business:')) return '智能体'
  const experiment = experiments.find(item => item.id === id)
  if (experiment?.is_variant === true || isVariantIdentity(id, experiment?.change)) return '变体'
  // 历史 EXP 也可能是变体，缺少可读声明时不按前缀猜测。
  if (!experiment || experiment.status === 'unavailable' || (!experiment.change && experiment.is_variant !== false)) return '待核对'
  return '智能体'
}

export function evaluationVersionLabel(id: string): string {
  if (id.startsWith('business:')) return id.includes('@') ? decodeURIComponent(id.slice(id.indexOf('@') + 1)) : '当前工作树'
  const version = /-(\d{3}(?:-r[0-9a-f]{12})?)$/.exec(id)?.[1]
  return version ? `v${version}` : id || '未记录'
}

export function evaluationAgentName(agents: { id: string; name?: string; manifest?: Record<string, any> }[], id?: string | null): string {
  const agent = agents.find(item => item.id === id)
  const name = [agent?.manifest?.name, agent?.name].find(value => typeof value === 'string' && value.trim())
  return name?.trim() || id || '智能体未知'
}
