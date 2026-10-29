import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface StandaloneConfig {
  agentId: string
  experimentId: string
  presetId: string
  profilePatch: string
  modelPatch: unknown[]
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  environmentKeys?: string[]
  mcp: { servers: any[]; groups: any[]; sharedToken: string; mountServerIds?: string[]; mountOverrides?: Record<string, { serverName?: string; tools?: any }> }
  compositions?: any
  fixedBindings?: Record<string, any>
  offlineKnowledge?: unknown
  sourceDigest?: string
  extensions?: Array<{ id: string; entry: string; sha256: string; sourceDigest: string }>
}

export const configPath = (home = process.env.DSH_HOME || '/var/lib/dsh') => join(home, 'standalone/config.json')
export function readStandaloneConfig(home?: string): StandaloneConfig {
  return validateStandaloneConfig(JSON.parse(readFileSync(configPath(home), 'utf8')))
}
export function validateStandaloneConfig(value: any): StandaloneConfig {
  if (!value || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.agentId ?? '') || typeof value.experimentId !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.presetId ?? '') || typeof value.profilePatch !== 'string'
    || value.profilePatch.startsWith('/') || value.profilePatch.split('/').some((part: string) => !part || ['.', '..'].includes(part))
    || value.profilePatch.includes('\\') || value.modelPatch !== undefined && !Array.isArray(value.modelPatch)
    || !value.mcp || !Array.isArray(value.mcp.servers) || !Array.isArray(value.mcp.groups)) throw new Error('独立智能体配置无效，请核对模型与 MCP 配置文件')
  if (value.environmentKeys && (!Array.isArray(value.environmentKeys) || value.environmentKeys.some((key: any) => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key)))) throw new Error('独立智能体环境配置键无效')
  return { ...value, modelPatch: value.modelPatch || [], mcp: { ...value.mcp, sharedToken: value.mcp.sharedToken || randomBytes(32).toString('hex') } }
}
export function writeStandaloneConfig(value: StandaloneConfig, home?: string) {
  const path = configPath(home)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = `${path}.${process.pid}.tmp`
  const { modelPatch: _modelPatch, defaultModel: _defaultModel, ...current } = validateStandaloneConfig(value)
  writeFileSync(next, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 })
  renameSync(next, path)
}
export function readEnvironment(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  let environment: unknown
  try { environment = JSON.parse(text) } catch { throw new Error('模型凭据文件必须是环境键到字符串值的 JSON 对象') }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.entries(environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error('模型凭据文件的环境变量格式无效')
  return environment as Record<string, string>
}
export function runtimeRoot() { return resolve(process.env.STANDALONE_ROOT || '/opt/standalone') }
