import type { Arch, FileEntry, ImageEntry } from '../manifest.mts'

export type DeploymentMode = 'online' | 'offline'
export interface AgentSeed {
  modelPatch?: unknown[]
  environment?: Record<string, string>
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  mcp?: { servers?: any[]; groups?: any[]; sharedToken?: string }
  compositions?: unknown
  fixedBindings?: unknown
  [key: string]: unknown
}
export interface AgentPackageInput {
  programRoot: string
  assetRoot: string
  agentId: string
  experimentId: string
  arch: Arch
  mode: DeploymentMode
  out?: string
  resourcesDir?: string
  expectedCandidateSha256?: string
  knowledgeSources?: Array<{ url: string; path: string }>
  seed?: AgentSeed
}
export interface AgentProgress { stage: string; message: string; current?: number; total?: number }
export interface AgentPackageHooks {
  signal?: AbortSignal
  onProgress?: (progress: AgentProgress) => void
}
export interface DependencyPackage {
  kind?: 'node' | 'python'
  path: string
  name: string
  dependencies: string[]
  lockSha256?: string
  modulesPath?: string
  sourceFile?: string
  reason?: string
  ready: boolean
  preparedTarget?: { image: string; imageId: string }
  preparedFiles?: FileEntry[]
}
export interface AgentSourceSnapshot {
  agentId: string
  experimentId: string
  candidate: string
  candidateSha256: string
  source: Record<string, any>
  files: Array<{ path: string; sourcePath: string; sha256: string; mode: number }>
  omitted: string[]
  dependencies: DependencyPackage[]
  git: { commit: string; dirty: boolean }
}
export interface AgentResourceManifest {
  schemaVersion: 1
  arch: Arch
  createdAt: string
  image: ImageEntry
  docker: { version?: string; composeVersion?: string; files: FileEntry[] }
  dependencies: Array<{ path: string; lockSha256?: string; files: FileEntry[]; preparedTarget?: DependencyPackage['preparedTarget'] }>
}
export interface AgentPackageManifest {
  schemaVersion: 1
  kind: 'standalone-agent'
  package: { name: string; arch: Arch; mode: DeploymentMode; createdAt: string; sensitive: true }
  source: {
    agentId: string; experimentId: string; candidateSha256: string; commit: string; dirty: boolean; profile?: 'web' | 'sdk'
    paths: { workspace: string; presets: string; managed: string; profilePatch: string; preset: string }
    files: AgentSourceSnapshot['files']; omitted: string[]
  }
  image: ImageEntry
  knowledge: unknown
  extensions?: unknown
  files: FileEntry[]
  sensitivePaths: string[]
}
