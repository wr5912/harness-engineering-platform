import { safeProjection } from './reports/common.ts'

export type DependencyStage = 'configuration' | 'discovery' | 'decode' | 'invocation' | 'execution'

const labels: Record<DependencyStage, string> = {
  configuration: '依赖配置异常',
  discovery: '依赖工具发现失败',
  decode: '依赖响应解析失败',
  invocation: '依赖工具调用失败',
  execution: '组合执行失败',
}

export function publicErrorText(value: unknown, fallback = '上游未提供可展示的错误详情'): string {
  const projected: any = safeProjection({ error: value }).error
  if (typeof projected === 'string' && projected) return projected.slice(0, 1000)
  if (projected !== undefined) {
    try { return JSON.stringify(projected).slice(0, 1000) } catch { return '上游错误详情无法安全展示' }
  }
  return fallback
}

export function dependencyError(stage: DependencyStage, details: {
  connection?: string
  operation?: string
  status?: number
  code?: string
  detail?: unknown
  receipt?: unknown
  cause?: unknown
}) {
  const parts = [labels[stage]]
  if (details.connection) parts.push(`连接=${details.connection}`)
  parts.push(`阶段=${stage}`)
  if (details.operation) parts.push(`操作=${details.operation}`)
  if (Number.isInteger(details.status)) parts.push(`MCP调度状态=${details.status}`)
  if (details.code) parts.push(`错误码=${details.code}`)
  if (details.detail !== undefined) parts.push(`上游原因=${publicErrorText(details.detail)}`)
  const error = details.cause === undefined
    ? new Error(parts.join('；'))
    : new Error(parts.join('；'), { cause: details.cause })
  return Object.assign(error, {
    ...(details.status === undefined ? {} : { status: details.status }),
    ...(details.code === undefined ? {} : { code: details.code }),
    ...(details.receipt === undefined ? {} : { receipt: safeProjection(details.receipt) }),
    stage,
    ...(details.connection === undefined ? {} : { serverId: details.connection }),
    ...(details.operation === undefined ? {} : { operationId: details.operation }),
  })
}
