import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export const CHANNEL = '/harness-platform'

// 服务端模块处理去掉前缀后的 endpoint，页面使用同一个原生认证 RPC。
export const DOMAIN_PREFIXES = ['agents/', 'instances/', 'mcp/', 'models/', 'assistant/'] as const
export type PageId = 'home' | 'conversations' | 'agents' | 'evaluation' | 'instances' | 'gateway' | 'mcp'
export interface PlatformNavigation {
  page: PageId
  replace?: boolean
  agent_id?: string
  experiment_id?: string
  run_id?: string
  run_tab?: 'report' | 'results' | 'trace' | 'files' | 'datasets'
  case_id?: string
  job_id?: string
  instance_name?: string
  source_id?: string
  server_id?: string
  group_id?: string
  composition_id?: string
  version?: 'draft' | 'published'
  version_id?: string
  intent?: 'start_eval'
  list_view?: 'agents' | 'variants'
  tab?: string
}
export interface PlatformPageProps {
  rpc: ClientConnectionRpc
}

export interface Asset {
  id: string
  path: string
}

export interface RunAsset extends Asset {
  experiment_id: string
}

export interface Inventory {
  schema_version: '1.0'
  root: string
  workspace?: { id: string; root: string; legacyRoots: string[] }
  observed_at: string
  agents: Asset[]
  experiments: Asset[]
  runs: RunAsset[]
}
